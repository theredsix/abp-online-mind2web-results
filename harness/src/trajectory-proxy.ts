// mind2web/harness/src/trajectory-proxy.ts
//
// HTTP reverse proxy that sits between browser-agent and ABP's MCP endpoint.
// Forwards all traffic transparently, but intercepts tool-call responses to
// record mind2web trajectory entries (action descriptions + screenshots).

import http from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { TrajectoryEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface TrajectoryProxyState {
  entries: TrajectoryEntry[];
  stepCounter: number;
  currentThought: string;
  /** ABP REST base (e.g. http://localhost:8222) — used to read the live URL. */
  abpBase: string;
}

export interface TrajectoryProxy {
  /** Port the proxy is listening on. */
  port: number;
  /** Shared state — trajectory entries accumulate here. */
  state: TrajectoryProxyState;
  /** Shut down the proxy server. */
  close: () => Promise<void>;
}

/**
 * Start an HTTP reverse proxy in front of ABP.
 *
 * - `/api/v1/*` requests are forwarded to ABP as-is (passthrough).
 * - `/mcp` POST requests are forwarded to ABP, then tool-call responses
 *   are intercepted to record trajectory entries with screenshots.
 * - All other requests (GET /mcp for SSE, etc.) are forwarded as-is.
 */
export async function startTrajectoryProxy(
  abpPort: number,
  trajectoryDir: string,
): Promise<TrajectoryProxy> {
  const abpBase = `http://localhost:${abpPort}`;
  const state: TrajectoryProxyState = {
    entries: [],
    stepCounter: 0,
    currentThought: "",
    abpBase,
  };

  const server = http.createServer(async (req, res) => {
    const pathname = req.url || "/";
    const targetUrl = `${abpBase}${pathname}`;
    if (req.method === "POST" && pathname === "/mcp") {
      await handleMcpPost(req, res, targetUrl, state, trajectoryDir);
    } else {
      await forwardRequest(req, res, targetUrl);
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        state,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// MCP POST handler — forward + intercept tool calls
// ---------------------------------------------------------------------------

async function handleMcpPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
  state: TrajectoryProxyState,
  trajectoryDir: string,
): Promise<void> {
  // 1. Read incoming request body
  const reqBody = await readBody(req);

  // 2. Forward to ABP
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: req.headers.accept || "application/json, text/event-stream",
  };
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && typeof sessionId === "string") {
    headers["Mcp-Session-Id"] = sessionId;
  }

  let abpRes: Response;
  try {
    abpRes = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: reqBody,
    });
  } catch (err) {
    res.writeHead(502);
    res.end(`Proxy error: ${err}`);
    return;
  }

  const contentType = abpRes.headers.get("content-type") || "";
  const resHeaders: Record<string, string> = {};
  abpRes.headers.forEach((value, key) => {
    resHeaders[key] = value;
  });

  // 3a. SSE response — stream through, intercept events for trajectory
  if (contentType.includes("text/event-stream")) {
    res.writeHead(abpRes.status, resHeaders);
    await handleSseResponse(reqBody, abpRes, res, state, trajectoryDir);
    return;
  }

  // 3b. JSON response — buffer, intercept, forward (original path)
  const resBody = await abpRes.text();

  try {
    const rpc = JSON.parse(reqBody);
    if (rpc.method === "tools/call") {
      const rpcRes = JSON.parse(resBody);
      await recordToolCall(
        rpc.params,
        rpcRes.result,
        state,
        trajectoryDir,
      );
    }
  } catch {
    // Non-fatal — don't break the proxy if interception fails
  }

  res.writeHead(abpRes.status, resHeaders);
  res.end(resBody);
}

// ---------------------------------------------------------------------------
// SSE streaming handler — stream SSE through while intercepting tool results
// ---------------------------------------------------------------------------

async function handleSseResponse(
  reqBody: string,
  abpRes: Response,
  res: http.ServerResponse,
  state: TrajectoryProxyState,
  trajectoryDir: string,
): Promise<void> {
  if (!abpRes.body) {
    res.end();
    return;
  }

  // Parse the original request to know if this was a tools/call
  let rpc: { method?: string; params?: any } | null = null;
  try {
    rpc = JSON.parse(reqBody);
  } catch {
    // Not valid JSON — just stream through
  }

  const reader = abpRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Forward raw bytes to client immediately
      res.write(value);

      // Also parse SSE events for trajectory recording
      if (rpc?.method === "tools/call") {
        sseBuffer += decoder.decode(value, { stream: true });
        sseBuffer = processSseBuffer(sseBuffer, rpc.params, state, trajectoryDir);
      }
    }
  } catch {
    // Client or upstream disconnected
  }
  res.end();
}

/**
 * Parse complete SSE events from the buffer, extract JSON-RPC results for
 * trajectory recording, and return the remaining incomplete buffer.
 */
function processSseBuffer(
  buffer: string,
  rpcParams: any,
  state: TrajectoryProxyState,
  trajectoryDir: string,
): string {
  // SSE events are separated by double newlines
  const parts = buffer.split("\n\n");
  // Last part may be incomplete — keep it in the buffer
  const remaining = parts.pop() || "";

  for (const part of parts) {
    // Extract "data:" lines from the SSE event
    const dataLines = part
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;

    const data = dataLines.join("");
    try {
      const rpcRes = JSON.parse(data);
      if (rpcRes.result) {
        // Fire-and-forget — don't block the stream
        recordToolCall(rpcParams, rpcRes.result, state, trajectoryDir).catch(
          () => {},
        );
      }
    } catch {
      // Not a JSON-RPC result event — ignore
    }
  }

  return remaining;
}

// ---------------------------------------------------------------------------
// Generic request forwarding (passthrough for REST API, SSE, etc.)
// ---------------------------------------------------------------------------

async function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
): Promise<void> {
  const reqBody = req.method === "POST" || req.method === "PUT"
    ? await readBody(req)
    : undefined;

  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (val && key !== "host" && key !== "connection") {
      headers[key] = Array.isArray(val) ? val[0] : val;
    }
  }

  let abpRes: Response;
  try {
    abpRes = await fetch(targetUrl, {
      method: req.method || "GET",
      headers,
      body: reqBody,
    });
  } catch (err) {
    res.writeHead(502);
    res.end(`Proxy error: ${err}`);
    return;
  }

  const resHeaders: Record<string, string> = {};
  abpRes.headers.forEach((value, key) => {
    resHeaders[key] = value;
  });
  res.writeHead(abpRes.status, resHeaders);

  // Stream the body (important for SSE responses)
  if (abpRes.body) {
    const reader = abpRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // Client may have disconnected
    }
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Trajectory recording
// ---------------------------------------------------------------------------

/** Tools that represent user-visible actions (vs. observation-only tools). */
const ACTION_TOOLS = new Set([
  "browser_action",
  "browser_navigate",
  "browser_scroll",
  "browser_select_picker",
  "browser_slider",
]);

/**
 * Read the live URL of the active tab from ABP's REST API. Used to populate the
 * `url` field of EVERY trajectory step (not just explicit navigations) — e.g. a
 * click that triggers a client-side route change still gets its resulting URL.
 * Best-effort: returns null on any failure so recording never breaks.
 */
async function getActiveTabUrl(abpBase: string): Promise<string | null> {
  try {
    const res = await fetch(`${abpBase}/api/v1/tabs`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const tabs = (await res.json()) as Array<{ url?: string; active?: boolean }>;
    if (!Array.isArray(tabs) || tabs.length === 0) return null;
    const active = tabs.find((t) => t.active) ?? tabs[0];
    return typeof active.url === "string" ? active.url : null;
  } catch {
    return null;
  }
}

async function recordToolCall(
  params: { name?: string; arguments?: Record<string, any> },
  result: { content?: Array<{ type: string; data?: string; mimeType?: string }> } | undefined,
  state: TrajectoryProxyState,
  trajectoryDir: string,
): Promise<void> {
  const toolName = params.name || "unknown";
  const args = params.arguments || {};

  if (!ACTION_TOOLS.has(toolName)) return;

  // Live page URL after this action — populates the url field for every step,
  // not just explicit navigations. Best-effort (null on failure).
  const liveUrl = await getActiveTabUrl(state.abpBase);

  // Extract screenshots from the MCP response (avoids an extra REST call).
  // Most tools return a single image; browser_scroll returns one image PER
  // scroll event (sequential image blocks), so keep them all in order.
  const imageBlocks = (result?.content ?? []).filter(
    (b) => b.type === "image" && b.data,
  );
  const imageBlock = imageBlocks[0];

  // browser_scroll accepts a `scrolls` array of 1-3 events and returns one
  // screenshot PER event. Fan out: each scroll event becomes its own step,
  // paired with its own captured frame — the user wants each image to be a
  // distinct step (opposite of browser_action, which returns a single frame).
  if (
    toolName === "browser_scroll" &&
    Array.isArray(args.scrolls) &&
    args.scrolls.length > 0
  ) {
    for (let i = 0; i < args.scrolls.length; i++) {
      const ev = args.scrolls[i] as Record<string, any>;
      state.stepCounter++;
      // The i-th image corresponds to the state after the i-th scroll. If the
      // server returned fewer images than events, carry the last available.
      const img = imageBlocks[i] ?? imageBlocks[imageBlocks.length - 1];
      const screenshotPath = img?.data
        ? await saveScreenshot(trajectoryDir, state.stepCounter, img.data)
        : "";

      const dpx = Number(ev.delta_px ?? 0);
      const axis = ev.direction === "x" ? "x" : "y";
      const dx = axis === "x" ? dpx : 0;
      const dy = axis === "y" ? dpx : 0;

      state.entries.push({
        step: state.stepCounter,
        action_type: "browser_scroll",
        action_description: `Scroll (delta_x=${dx}, delta_y=${dy})`,
        element_descriptor: null,
        thought: state.currentThought,
        screenshot_path: screenshotPath,
        timestamp: Date.now(),
        v2_action: `SCROLL page -> scroll (delta_x=${dx}, delta_y=${dy}) | SUCCESS`,
        v2_status: "SUCCESS",
        url: liveUrl,
      });
    }
    return;
  }

  // A browser_action call can BUNDLE several sub-actions, but ABP returns a
  // single screenshot (the state after the whole bundle ran). Collapse the
  // bundle into ONE step so the step's single screenshot truthfully matches
  // its action — rather than fanning out and duplicating that one frame
  // across sub-steps that supposedly preceded it. Sub-actions are joined into
  // a single compound Grammar-A action string with one trailing status.
  if (toolName === "browser_action" && Array.isArray(args.actions) && args.actions.length > 0) {
    state.stepCounter++;
    const screenshotPath = imageBlock?.data
      ? await saveScreenshot(trajectoryDir, state.stepCounter, imageBlock.data)
      : "";

    const subs = args.actions.map((a: Record<string, any>) => v2ForSubAction(a));
    // Bundle status is FAILED if any sub-action failed, else SUCCESS.
    const status: "SUCCESS" | "FAILED" =
      subs.some((s) => s.status === "FAILED") ? "FAILED" : "SUCCESS";
    // Join each sub-action's Grammar-A fragment (minus its own status suffix)
    // and append one shared status. A single sub-action collapses to exactly
    // its normal Grammar-A string (the common case), so nothing changes there.
    const stripStatus = (a: string) =>
      a.replace(/\s*\|\s*(SUCCESS|FAILED)\s*$/, "");
    const v2action =
      subs.map((s) => stripStatus(s.action)).join(" ; ") + ` | ${status}`;
    // A navigate sub-action (rare inside a bundle) may carry a destination url;
    // otherwise use the live post-action URL.
    const url = subs.find((s) => s.url)?.url ?? liveUrl;

    state.entries.push({
      step: state.stepCounter,
      action_type:
        args.actions.length === 1
          ? args.actions[0].type || "browser_action"
          : "browser_action",
      action_description: args.actions
        .map((a: Record<string, any>) => describeSubAction(a))
        .join("; "),
      element_descriptor: null,
      thought: state.currentThought,
      screenshot_path: screenshotPath,
      timestamp: Date.now(),
      v2_action: v2action,
      v2_status: status,
      url,
    });
    return;
  }

  // Single-action tools
  state.stepCounter++;
  const screenshotPath = imageBlock?.data
    ? await saveScreenshot(trajectoryDir, state.stepCounter, imageBlock.data)
    : "";
  const v2 = v2ForTool(toolName, args);

  state.entries.push({
    step: state.stepCounter,
    action_type: toolName,
    action_description: describeToolCall(toolName, args),
    element_descriptor: null,
    thought: state.currentThought,
    screenshot_path: screenshotPath,
    timestamp: Date.now(),
    v2_action: v2.action,
    v2_status: v2.status,
    url: v2.url ?? liveUrl,
  });
}

// ---------------------------------------------------------------------------
// v2 action-grammar builders (Online-Mind2Web schema_v2, Grammar A)
//   Pointer/selector verbs: "<VERB> <target> -> <desc> | <STATUS>"
//   Page-level verbs:       "page -> <VERB> -> <desc> | <STATUS>"
// ---------------------------------------------------------------------------

interface V2Action {
  action: string;
  status: "SUCCESS" | "FAILED" | null;
  url?: string | null;
}

// ABP browser_action sub-action types — the complete set from the live tool
// schema (actions.items.oneOf): mouse_click, keyboard_type, keyboard_press,
// mouse_hover, mouse_drag. There is NO wait/scroll/mouse_move sub-action here
// (those are separate top-level tools), so the default branch only fires on a
// genuinely malformed sub-action.
function v2ForSubAction(a: Record<string, any>): V2Action {
  switch (a.type) {
    case "mouse_click": {
      const n = Number(a.click_count ?? 1);
      const kind = n === 2 ? "double-click" : n === 3 ? "triple-click" : "click";
      return { action: `CLICK coords(${a.x}, ${a.y}) -> ${kind} at (${a.x}, ${a.y}) | SUCCESS`, status: "SUCCESS" };
    }
    case "keyboard_type": {
      const text = String(a.text ?? "");
      return { action: `TYPE page -> type "${text}" | SUCCESS`, status: "SUCCESS" };
    }
    case "keyboard_press": {
      const key = [...(a.modifiers || []), a.key].join("+");
      return { action: `PRESS_KEY page -> press ${key} | SUCCESS`, status: "SUCCESS" };
    }
    case "mouse_hover":
      return { action: `HOVER coords(${a.x}, ${a.y}) -> hover at (${a.x}, ${a.y}) | SUCCESS`, status: "SUCCESS" };
    case "mouse_drag":
      return { action: `CLICK coords(${a.start_x}, ${a.start_y}) -> drag from (${a.start_x}, ${a.start_y}) to (${a.end_x}, ${a.end_y}) | SUCCESS`, status: "SUCCESS" };
    default:
      return { action: `page -> WAIT -> unrecognized sub-action '${a.type ?? "unknown"}' | FAILED`, status: "FAILED" };
  }
}

function v2ForTool(toolName: string, args: Record<string, any>): V2Action {
  switch (toolName) {
    case "browser_navigate":
      return {
        action: `page -> NAVIGATE -> navigate to ${args.url ?? args.action ?? "page"} | SUCCESS`,
        status: "SUCCESS",
        url: typeof args.url === "string" ? args.url : null,
      };
    case "browser_scroll": {
      // Fallback for a scroll call without the `scrolls` array (the array form
      // is fanned out before reaching here). Sum events onto each axis.
      let dx = 0, dy = 0;
      for (const ev of (args.scrolls ?? []) as Array<Record<string, any>>) {
        const dpx = Number(ev.delta_px ?? 0);
        if (ev.direction === "x") dx += dpx; else dy += dpx;
      }
      return { action: `SCROLL page -> scroll (delta_x=${dx}, delta_y=${dy}) | SUCCESS`, status: "SUCCESS" };
    }
    case "browser_select_picker":
      if (args.cancel) return { action: `SELECT page -> cancel picker ${args.popup_id} | SUCCESS`, status: "SUCCESS" };
      return { action: `SELECT page -> select option(s) [${(args.indices || []).join(", ")}] in picker ${args.popup_id} | SUCCESS`, status: "SUCCESS" };
    case "browser_slider":
      return { action: `SELECT page -> set ${args.orientation} slider to ${args.target_value} | SUCCESS`, status: "SUCCESS" };
    case "browser_action":
      // Reached only when browser_action had no valid `actions` array.
      return { action: `page -> WAIT -> malformed browser_action (no effect) | FAILED`, status: "FAILED" };
    default:
      return { action: `page -> WAIT -> ${toolName} | SUCCESS`, status: "SUCCESS" };
  }
}

// ---------------------------------------------------------------------------
// Action description builders
// ---------------------------------------------------------------------------

function describeSubAction(action: Record<string, any>): string {
  switch (action.type) {
    case "mouse_click":
      return `Click at (${action.x}, ${action.y})`;
    case "keyboard_type":
      return `Type "${action.text}"`;
    case "keyboard_press":
      return `Press ${[...(action.modifiers || []), action.key].join("+")}`;
    case "mouse_hover":
      return `Hover at (${action.x}, ${action.y})`;
    case "mouse_drag":
      return `Drag from (${action.start_x}, ${action.start_y}) to (${action.end_x}, ${action.end_y})`;
    default:
      return `${action.type || "unknown action"}`;
  }
}

function describeToolCall(
  toolName: string,
  args: Record<string, any>,
): string {
  switch (toolName) {
    case "browser_navigate":
      return args.url
        ? `Navigate to ${args.url}`
        : `Navigate ${args.action || "unknown"}`;
    case "browser_scroll": {
      let dx = 0, dy = 0;
      for (const ev of (args.scrolls ?? []) as Array<Record<string, any>>) {
        const dpx = Number(ev.delta_px ?? 0);
        if (ev.direction === "x") dx += dpx; else dy += dpx;
      }
      return `Scroll (delta_x=${dx}, delta_y=${dy})`;
    }
    case "browser_select_picker":
      if (args.cancel) return `Select picker ${args.popup_id} -> CANCEL`;
      return `Select picker ${args.popup_id} -> Select option(s) [${(args.indices || []).join(", ")}]`;
    case "browser_slider":
      return `Slider (${args.orientation}) set to ${args.target_value} [range ${args.min}-${args.max}]`;
    default:
      return toolName;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Persist a raw per-action screenshot. Files land in `dir` (a scratch dir);
 * the converter later copies them into trajectory/ under the schema_v2
 * NNNN.png names once final step indices are known. Returns the ABSOLUTE
 * path (so the converter can read it), or "" if the frame couldn't be saved
 * — in which case the converter carries the previous frame forward.
 */
async function saveScreenshot(
  dir: string,
  step: number,
  base64Data: string,
): Promise<string> {
  const filepath = join(dir, `raw_${step}.png`);
  try {
    const webpBuffer = Buffer.from(base64Data, "base64");
    const pngBuffer = await sharp(webpBuffer).png().toBuffer();
    await writeFile(filepath, pngBuffer);
  } catch {
    return "";
  }
  return filepath;
}

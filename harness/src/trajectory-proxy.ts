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

async function recordToolCall(
  params: { name?: string; arguments?: Record<string, any> },
  result: { content?: Array<{ type: string; data?: string; mimeType?: string }> } | undefined,
  state: TrajectoryProxyState,
  trajectoryDir: string,
): Promise<void> {
  const toolName = params.name || "unknown";
  const args = params.arguments || {};

  if (!ACTION_TOOLS.has(toolName)) return;

  // Extract screenshot from MCP response (avoids extra REST call)
  const imageBlock = result?.content?.find(
    (b) => b.type === "image" && b.data,
  );

  // For browser_action, create an entry per sub-action
  if (toolName === "browser_action" && Array.isArray(args.actions)) {
    for (const action of args.actions) {
      state.stepCounter++;
      const screenshotPath = imageBlock?.data
        ? await saveScreenshot(trajectoryDir, state.stepCounter, imageBlock.data)
        : "";

      state.entries.push({
        step: state.stepCounter,
        action_type: action.type || "browser_action",
        action_description: describeSubAction(action),
        element_descriptor: null,
        thought: state.currentThought,
        screenshot_path: screenshotPath,
        timestamp: Date.now(),
      });
    }
    return;
  }

  // Single-action tools
  state.stepCounter++;
  const screenshotPath = imageBlock?.data
    ? await saveScreenshot(trajectoryDir, state.stepCounter, imageBlock.data)
    : "";

  state.entries.push({
    step: state.stepCounter,
    action_type: toolName,
    action_description: describeToolCall(toolName, args),
    element_descriptor: null,
    thought: state.currentThought,
    screenshot_path: screenshotPath,
    timestamp: Date.now(),
  });
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
    case "browser_scroll":
      return `Scroll (delta_x=${args.delta_x ?? 0}, delta_y=${args.delta_y ?? 0})`;
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

async function saveScreenshot(
  dir: string,
  step: number,
  base64Data: string,
): Promise<string> {
  const filename = `${step}_full_screenshot.png`;
  const filepath = join(dir, filename);
  try {
    const webpBuffer = Buffer.from(base64Data, "base64");
    const pngBuffer = await sharp(webpBuffer).png().toBuffer();
    await writeFile(filepath, pngBuffer);
  } catch {
    // Non-fatal — return path even if save fails
  }
  return filepath;
}

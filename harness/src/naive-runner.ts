// mind2web/harness/src/naive-runner.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { AbpHelper } from "./abp.js";
import { convertAndSave } from "./converter.js";
import { startHarnessTools } from "./harness-tools.js";
import { startTrajectoryProxy } from "./trajectory-proxy.js";
import type { TaskResult } from "./types.js";
import type {
  BenchmarkConfig,
  Mind2WebTask,
  TaskTrajectory,
} from "./types.js";

const SYSTEM_PROMPT = `You are a web automation agent. Complete the given task on the current website.

## How the browser works

You control a browser through ABP (Agent Browser Protocol). Each tool call is one atomic step:
1. You send an action (click, type, scroll, navigate)
2. The browser executes it, waits for the page to settle, then freezes JavaScript and virtual time
3. You receive back: a screenshot, scroll position, cursor position, and any events (navigations, dialogs, etc.)
4. You inspect the screenshot, decide your next action, and repeat

Every action automatically returns a screenshot — you do not need to take one separately.
If you need to wait for the page to finish loading after a navigation or click that triggers async content, call browser_screenshot to get a fresh settled state.

## Approach

Take the task instruction literally. Do exactly what is asked — no more, no less. Do not second-guess the request, consider edge cases that aren't mentioned, or add extra steps "just in case." If the task says "find X," find X and stop. Do not overthink or reason about second- and third-order effects.

## Guidelines

- Always prefer the website's search functionality over browsing menus or categories to find items
- Before paginating through any list or table, first look for filter/sort controls — they may be hidden behind a "Filter" button, sidebar toggle, or dropdown. Scroll through all available filter options to see the full set before setting any, then apply all relevant filters to narrow results before scrolling or paging through them
- After setting filters, check whether they take effect immediately (the results update, the URL changes, or a loading indicator appears) or require an explicit "Apply" / "Search" / "Go" button. If results haven't changed after selecting a filter, look for such a button and click it
- Trust the sort order shown by the website — take results at face value unless an item is visibly an ad or sponsored result that breaks the sorting order
- Stay on the current website by clicking links and using the site's own navigation. Do not use browser_navigate() to jump to URLs — discover pages by interacting with the page
- Never execute JavaScript on the page — use only the provided browser tools
- Never navigate to URLs from memory — always discover links by interacting with the current page
- When reading a page or scanning a list, scroll in ~75% viewport increments to cover ground quickly while keeping overlap for sticky headers
- When trying to locate a specific element or target for clicking, use smaller scrolls to position precisely
- Extract and synthesize data directly from the webpage to form your answer — do not rely on prior knowledge
- ALWAYS accept handle cookie banners FIRST before interacting with any other popups
- If you have taken more than 20 steps and have seen a plausible answer, commit to it rather than continuing to search for a perfect one — a good answer now beats no answer
- When using search or autocomplete fields, check if a matching suggestion appears — but if none matches, submit your query directly (e.g. press ENTER) rather than giving up
- When a dropdown list is long and the value you need is not visible, type the first few characters of the desired value to jump to it — most dropdowns support prefix matching
- After typing into a text field, verify that the field contains exactly the text you intended. Pre-populated forms often prepend or append existing values to your input. If the field content doesn't match what you expected, call browser_clear_text() to clear it completely, then re-type your desired value
- If a click lands on the wrong element, call browser_screenshot with the grid markup enabled to get a coordinate overlay, then use the grid to pick the correct coordinates for your next click

## Recording and submitting answers

Call potential_solution early and often to save your progress. Any time you see a plausible answer, call it with status "success". Any time you suspect the task may be impossible, call it with status "impossible" and an explanation. Each call overwrites the previous one, so always call it with your current best answer or assessment. If you run out of steps, your last potential_solution is automatically submitted as your final answer.

When you are confident in your answer, call declare_result to submit it and stop. Do not simply state the answer in text; you must explicitly call declare_result with the answer string. If the task is impossible — due to missing or changed functionality, a site outage, or a feature that clearly does not exist — call declare_result with status "impossible".

## Answer formatting (IMPORTANT)

The answer string you pass to potential_solution and declare_result MUST be plain ASCII English only:
- Use only standard ASCII characters (codes 0x20-0x7E). Do NOT use Unicode symbols, emoji, smart/curly quotes, em/en dashes, non-breaking spaces, check marks, or box-drawing characters.
- Replace would-be Unicode with ASCII equivalents: use "-" for dashes, plain quotes ' and ", "Yes"/"No" or "[x]"/"[ ]" instead of check marks, ">=" / "<=" instead of inequality symbols, and "->" for arrows.
- If a table is needed, format it with ASCII pipes (|) and hyphens (-) only.
- Transliterate any non-English or accented text to plain ASCII (e.g. "cafe" not "café").`;

/**
 * Write the raw agent event trace to raw_trace.json beside result.json.
 * Includes a `summary` that surfaces off-browser tool usage (Bash, WebFetch,
 * etc.) — the escape hatches that can produce an answer without the browser,
 * which would make the schema_v2 trajectory unrepresentative of how the task
 * was actually solved.
 */
async function writeRawTrace(
  taskDir: string,
  task: Mind2WebTask,
  config: BenchmarkConfig,
  events: Array<Record<string, unknown>>,
  outcome: string,
  error?: string,
): Promise<void> {
  const toolUses = events.filter((e) => e.type === "tool_use");
  const offBrowser = toolUses.filter((e) => e.off_browser);
  const byTool: Record<string, number> = {};
  for (const e of offBrowser) {
    const name = String(e.tool ?? "unknown");
    byTool[name] = (byTool[name] ?? 0) + 1;
  }
  const doc = {
    task_id: task.task_id,
    task: task.confirmed_task,
    website: task.website,
    model: config.model,
    outcome,
    ...(error ? { error } : {}),
    summary: {
      total_events: events.length,
      tool_calls: toolUses.length,
      off_browser_tool_calls: offBrowser.length,
      off_browser_by_tool: byTool,
    },
    events,
  };
  await writeFile(
    join(taskDir, "raw_trace.json"),
    JSON.stringify(doc, null, 2),
  );
}

export async function runNaiveTask(
  task: Mind2WebTask,
  config: BenchmarkConfig,
): Promise<TaskResult> {
  const startTime = Date.now();
  const taskDir = join(config.outputDir, task.task_id);
  // Scratch dir for raw per-action frames; the converter copies these into
  // trajectory/ under schema_v2 NNNN.png names once step indices are final.
  const rawDir = join(taskDir, ".shots");
  await mkdir(rawDir, { recursive: true });

  // Initial page frame (carry-forward fallback for a step-0 with no capture)
  // and a final frame for the terminal TASK_COMPLETE step. Absolute paths.
  let initialScreenshot = "";
  let finalScreenshot = "";

  // Raw, unfiltered audit trail of EVERY agent event — including tools the
  // trajectory proxy never sees (Bash, WebFetch, ToolSearch, etc.). Written to
  // raw_trace.json next to result.json so a run can be reconciled against the
  // schema_v2 trajectory and any out-of-browser tool use can be caught.
  // Hoisted above try/catch so a failed run still emits whatever was captured.
  const rawTrace: Array<Record<string, unknown>> = [];
  let seq = 0;

  const abp = new AbpHelper(config.abpPort);
  let proxy: Awaited<ReturnType<typeof startTrajectoryProxy>> | null = null;
  let harness: Awaited<ReturnType<typeof startHarnessTools>> | null = null;

  try {
    await abp.waitForReady();
    await abp.resetTabs();

    // Navigate to the task's starting URL before handing off to the agent
    const tabId = await abp.getActiveTabId();
    await abp.navigateTo(tabId, task.website);

    // Pre-handoff capture for step 0 (`0000.png`): ALWAYS trigger an ABP WAIT
    // action before handing the session to the agent, and use the WAIT's own
    // screenshot. This makes step 0 a truthful product of a real browser action
    // observing the settled landing page (vs. a bare REST screenshot), and the
    // WAIT gives the page a final moment to settle after navigateTo.
    try {
      const initialPng = await abp.waitAndCapturePng(tabId);
      const p = join(rawDir, "raw_initial.png");
      await writeFile(p, initialPng);
      initialScreenshot = p;
    } catch {
      // Non-fatal — converter falls back to the first action's screenshot.
    }

    proxy = await startTrajectoryProxy(config.abpPort, rawDir);
    harness = await startHarnessTools();

    const prompt = `Task: ${task.confirmed_task}\nWebsite: ${task.website}`;

    let finalResponse = "";
    let resultSubtype = "";

    const q = query({
      prompt,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: config.model,
        maxTurns: config.maxTurns,
        mcpServers: {
          abp: {
            type: "http",
            url: `http://localhost:${proxy.port}/mcp`,
          },
          harness: {
            type: "http",
            url: `http://localhost:${harness.port}/mcp`,
          },
        },
        // Locked-down tool surface (per the Agent SDK permissions docs):
        // allowedTools pre-approves ONLY the ABP browser MCP server and the
        // harness submission MCP server; permissionMode "dontAsk" denies
        // anything not pre-approved instead of prompting (and skips
        // canUseTool). This forces the agent to solve the task using ONLY the
        // real browser — no Bash/curl/WebFetch escape hatches that would make
        // the schema_v2 trajectory unrepresentative of how the answer was got.
        allowedTools: ["mcp__abp__*", "mcp__harness__*"],
        permissionMode: "dontAsk",
      },
    });

    let lastTimestamp = Date.now();

    for await (const message of q) {
      const now = Date.now();
      const elapsedMs = now - lastTimestamp;
      lastTimestamp = now;

      if (message.type === "assistant") {
        const thoughts: string[] = [];
        let firstBlock = true;
        for (const block of message.message.content) {
          const timing = firstBlock ? { elapsed_ms: elapsedMs } : {};
          firstBlock = false;
          if (block.type === "text") {
            thoughts.push(block.text);
            process.stdout.write(JSON.stringify({ type: "thought", text: block.text, ...timing }) + "\n");
            rawTrace.push({ seq: seq++, t: now - startTime, type: "thought", text: block.text });
          } else if (block.type === "tool_use") {
            process.stdout.write(JSON.stringify({ type: "action", tool: block.name, input: block.input, ...timing }) + "\n");
            // Flag any tool outside the intended ABP/harness allowlist — these
            // are the out-of-browser escape hatches (Bash, WebFetch, …).
            const offBrowser = !/^mcp__(abp|harness)__/.test(block.name);
            rawTrace.push({
              seq: seq++,
              t: now - startTime,
              type: "tool_use",
              tool: block.name,
              input: block.input,
              off_browser: offBrowser,
            });
          }
        }
        if (thoughts.length > 0) {
          proxy.state.currentThought = thoughts.join("\n");
        }
      } else if (message.type === "user") {
        process.stdout.write(JSON.stringify({ type: "browser", elapsed_ms: elapsedMs }) + "\n");
        // Record tool results (the observation the agent receives back).
        const content = (message as { message?: { content?: unknown } }).message?.content;
        for (const block of (Array.isArray(content) ? content : [])) {
          const b = block as Record<string, any>;
          if (b?.type === "tool_result") {
            // Summarize: keep text, note (don't inline) any image payloads.
            const parts = Array.isArray(b.content) ? b.content : [];
            const text = parts
              .filter((p: any) => p?.type === "text")
              .map((p: any) => String(p.text ?? ""))
              .join("\n");
            const images = parts.filter((p: any) => p?.type === "image").length;
            rawTrace.push({
              seq: seq++,
              t: now - startTime,
              type: "tool_result",
              tool_use_id: b.tool_use_id,
              is_error: !!b.is_error,
              text: text.length > 2000 ? text.slice(0, 2000) + "…[truncated]" : text,
              image_blocks: images,
            });
          }
        }
      } else if (message.type === "result") {
        // SDK >=0.3: SDKResultMessage is a union — only the "success" subtype
        // carries `result`; the error variants don't. Narrow before reading.
        finalResponse = message.subtype === "success" ? message.result : "";
        resultSubtype = message.subtype;
        rawTrace.push({
          seq: seq++,
          t: now - startTime,
          type: "result",
          subtype: message.subtype,
        });
      }

      // Stop immediately once the agent declares a result
      if (harness.state.declaredResult !== null) {
        await q.interrupt();
        break;
      }
    }

    // Prefer explicitly declared result, then fall back to potential solution
    let outcome: "success" | "impossible" = "success";
    if (harness.state.declaredResult !== null) {
      finalResponse = harness.state.declaredResult;
      outcome = harness.state.declaredStatus;
      resultSubtype = outcome;
    } else if (harness.state.potentialResult !== null) {
      finalResponse = harness.state.potentialResult;
      outcome = harness.state.potentialStatus;
      resultSubtype = outcome;
    }

    // Capture a final frame for the terminal TASK_COMPLETE step.
    try {
      const finalPng = await abp.takeScreenshotPng(tabId);
      const p = join(rawDir, "raw_final.png");
      await writeFile(p, finalPng);
      finalScreenshot = p;
    } catch {
      // Non-fatal — converter carries the last action frame forward.
    }

    const trajectory: TaskTrajectory = {
      task,
      entries: proxy.state.entries,
      final_response: finalResponse,
      result_status: resultSubtype,
      initial_screenshot: initialScreenshot,
      final_screenshot: finalScreenshot,
    };
    const resultPath = await convertAndSave(trajectory, config.outputDir);

    // Persist the raw audit trail next to result.json.
    await writeRawTrace(taskDir, task, config, rawTrace, outcome);

    return {
      task_id: task.task_id,
      outcome,
      steps: proxy.state.entries.length,
      resultPath,
      durationMs: Date.now() - startTime,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    try {
      const partialTrajectory: TaskTrajectory = {
        task,
        entries: proxy?.state.entries ?? [],
        final_response: "",
        result_status: "error",
        initial_screenshot: initialScreenshot,
        final_screenshot: finalScreenshot,
        error: errorMsg,
      };
      await convertAndSave(partialTrajectory, config.outputDir);
      await writeRawTrace(taskDir, task, config, rawTrace, "failure", errorMsg);
    } catch {
      /* ignore save failures */
    }

    return {
      task_id: task.task_id,
      outcome: "failure",
      steps: proxy?.state.entries.length ?? 0,
      error: errorMsg,
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (proxy) await proxy.close();
    if (harness) await harness.close();
    // Drop the scratch frame dir; the converter has copied what it needs
    // into trajectory/ and schema_v2 discourages extra files in the package.
    await rm(rawDir, { recursive: true, force: true }).catch(() => {});
  }
}

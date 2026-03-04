// mind2web/harness/src/naive-runner.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AbpHelper } from "./abp.js";
import { convertAndSave } from "./converter.js";
import { startHarnessTools } from "./harness-tools.js";
import { startTrajectoryProxy } from "./trajectory-proxy.js";
import type { TaskResult } from "./runner.js";
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

When you are confident in your answer, call declare_result to submit it and stop. Do not simply state the answer in text; you must explicitly call declare_result with the answer string. If the task is impossible — due to missing or changed functionality, a site outage, or a feature that clearly does not exist — call declare_result with status "impossible".`;

export async function runNaiveTask(
  task: Mind2WebTask,
  config: BenchmarkConfig,
): Promise<TaskResult> {
  const startTime = Date.now();
  const taskDir = join(config.outputDir, task.task_id);
  const trajectoryDir = join(taskDir, "trajectory");
  await mkdir(trajectoryDir, { recursive: true });

  const abp = new AbpHelper(config.abpPort);
  let proxy: Awaited<ReturnType<typeof startTrajectoryProxy>> | null = null;
  let harness: Awaited<ReturnType<typeof startHarnessTools>> | null = null;

  // Remove CLAUDECODE env var so the SDK can spawn a Claude Code subprocess
  const savedClaudeCode = process.env.CLAUDECODE;
  delete process.env.CLAUDECODE;

  try {
    await abp.waitForReady();
    await abp.resetTabs();

    // Navigate to the task's starting URL before handing off to the agent
    const tabId = await abp.getActiveTabId();
    await abp.navigateTo(tabId, task.website);

    proxy = await startTrajectoryProxy(config.abpPort, trajectoryDir);
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
          } else if (block.type === "tool_use") {
            process.stdout.write(JSON.stringify({ type: "action", tool: block.name, input: block.input, ...timing }) + "\n");
          }
        }
        if (thoughts.length > 0) {
          proxy.state.currentThought = thoughts.join("\n");
        }
      } else if (message.type === "user") {
        process.stdout.write(JSON.stringify({ type: "browser", elapsed_ms: elapsedMs }) + "\n");
      } else if (message.type === "result") {
        finalResponse = message.result ?? "";
        resultSubtype = message.subtype;
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

    const trajectory: TaskTrajectory = {
      task,
      entries: proxy.state.entries,
      final_response: finalResponse,
      result_status: resultSubtype,
    };
    const resultPath = await convertAndSave(trajectory, config.outputDir);

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
        error: errorMsg,
      };
      await convertAndSave(partialTrajectory, config.outputDir);
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
    // Restore CLAUDECODE env var
    if (savedClaudeCode !== undefined) process.env.CLAUDECODE = savedClaudeCode;
    if (proxy) await proxy.close();
    if (harness) await harness.close();
  }
}

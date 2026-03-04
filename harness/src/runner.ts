// mind2web/harness/src/runner.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AbpHelper } from "./abp.js";
import { runAgent } from "./agent.js";
import { convertAndSave } from "./converter.js";
import { startTrajectoryProxy } from "./trajectory-proxy.js";
import type {
  BenchmarkConfig,
  Mind2WebTask,
  TaskTrajectory,
} from "./types.js";

export interface TaskResult {
  task_id: string;
  outcome: "success" | "failure" | "impossible";
  steps: number;
  resultPath?: string;
  error?: string;
  durationMs: number;
}

/**
 * Run a single mind2web task end-to-end using the browser-agent.
 *
 * Lifecycle:
 *   1. Verify ABP browser is ready
 *   2. Reset browser state (close extra tabs, navigate to about:blank)
 *   3. Start trajectory proxy in front of ABP
 *   4. Run the browser-agent (pointed at the proxy, not ABP directly)
 *   5. Collect trajectory entries from the proxy state
 *   6. Convert to mind2web result format and save
 */
export async function runTask(
  task: Mind2WebTask,
  config: BenchmarkConfig,
): Promise<TaskResult> {
  const startTime = Date.now();
  const taskDir = join(config.outputDir, task.task_id);
  const trajectoryDir = join(taskDir, "trajectory");
  await mkdir(trajectoryDir, { recursive: true });

  const abp = new AbpHelper(config.abpPort);
  let proxy: Awaited<ReturnType<typeof startTrajectoryProxy>> | null = null;

  try {
    // 1. Verify ABP is ready
    await abp.waitForReady();

    // 2. Reset browser state
    await abp.resetTabs();

    // 3. Start trajectory proxy (picks a free port)
    proxy = await startTrajectoryProxy(config.abpPort, trajectoryDir);

    // 4. Run browser-agent through the proxy
    //    browser-agent derives apiUrl and mcpUrl from this base URL,
    //    so all REST and MCP traffic flows through our proxy.
    const { finalResponse } = await runAgent(task, config, proxy.port);

    // 5. Build trajectory from proxy state and save
    const trajectory: TaskTrajectory = {
      task,
      entries: proxy.state.entries,
      final_response: finalResponse,
      result_status: "success",
    };
    const resultPath = await convertAndSave(trajectory, config.outputDir);

    return {
      task_id: task.task_id,
      outcome: "success",
      steps: proxy.state.entries.length,
      resultPath,
      durationMs: Date.now() - startTime,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Try to save partial trajectory data even on failure
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
    // Always clean up the proxy server
    if (proxy) {
      await proxy.close();
    }
  }
}

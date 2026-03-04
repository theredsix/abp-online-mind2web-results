// mind2web/harness/src/agent.ts
import { executeRequest } from "browser-agent/src/orchestrator/compact-loop.js";
import type { RequestOrchestratorOptions } from "browser-agent/src/orchestrator/compact-loop.js";
import type { AgentResponse } from "browser-agent/src/types.js";
import { join } from "node:path";
import type { BenchmarkConfig, Mind2WebTask } from "./types.js";

/**
 * Run the browser-agent on a single mind2web task.
 *
 * @param proxyPort - Port of the trajectory proxy. browser-agent connects
 *   here instead of directly to ABP, so all MCP tool calls are intercepted
 *   for trajectory recording.
 */
export async function runAgent(
  task: Mind2WebTask,
  config: BenchmarkConfig,
  proxyPort: number,
): Promise<{ response: AgentResponse; finalResponse: string }> {
  const orchestratorOptions: RequestOrchestratorOptions = {
    memoryDir: join(config.outputDir, ".memory"),
    abpUrl: `http://localhost:${proxyPort}`,
    headless: config.headless,
  };

  const response = await executeRequest(
    {
      goal: task.confirmed_task,
      url: task.website,
      config: {
        model: config.model,
        maxTurns: config.maxTurns,
      },
    },
    orchestratorOptions,
  );

  return {
    response,
    finalResponse: response.answer,
  };
}

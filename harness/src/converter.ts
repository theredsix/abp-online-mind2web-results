// mind2web/harness/src/converter.ts
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Mind2WebResult, TaskTrajectory } from "./types.js";

/**
 * Convert a TaskTrajectory into the mind2web result.json format
 * and write it to the output directory.
 */
export async function convertAndSave(
  trajectory: TaskTrajectory,
  outputDir: string,
): Promise<string> {
  const taskDir = join(outputDir, trajectory.task.task_id);
  await mkdir(taskDir, { recursive: true });

  const result: Mind2WebResult = {
    task_id: trajectory.task.task_id,
    task: trajectory.task.confirmed_task,
    final_result_response: trajectory.final_response || "",
    result_status: trajectory.result_status,
    action_history: trajectory.entries.map((e) => e.action_description),
    thoughts: trajectory.entries.map((e) => e.thought || ""),
  };

  const resultPath = join(taskDir, "result.json");
  await writeFile(resultPath, JSON.stringify(result, null, 4));

  return resultPath;
}

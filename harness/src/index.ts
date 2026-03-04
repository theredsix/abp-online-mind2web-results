// mind2web/harness/src/index.ts
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "./config.js";
import { runNaiveTask } from "./naive-runner.js";
import type { TaskResult } from "./types.js";
import type { Mind2WebTask } from "./types.js";

async function main() {
  const config = parseConfig(process.argv.slice(2));

  // Ensure output directory exists
  await mkdir(config.outputDir, { recursive: true });

  // Load dataset
  const raw = await readFile(config.datasetPath, "utf-8");
  let tasks: Mind2WebTask[] = JSON.parse(raw);

  // Apply filters
  if (config.taskId) {
    tasks = tasks.filter((t) => t.task_id === config.taskId);
  }
  if (config.level) {
    tasks = tasks.filter((t) => t.level === config.level);
  }
  if (config.limit !== undefined) {
    tasks = tasks.slice(0, config.limit);
  }

  if (tasks.length === 0) {
    console.error("No tasks match the given filters.");
    process.exit(1);
  }

  console.log(
    `Running ${tasks.length} tasks (model: ${config.model}, max turns: ${config.maxTurns})`,
  );
  console.log(`Output: ${config.outputDir}`);
  console.log("");

  const results: TaskResult[] = [];
  const failures: Array<{ task_id: string; error: string }> = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const progress = `[${i + 1}/${tasks.length}]`;

    // Resume: skip if result.json already exists in any result directory
    if (config.resume) {
      const dirsToCheck = [config.outputDir, ...config.resultDirs];
      let found = false;
      for (const dir of dirsToCheck) {
        try {
          await access(join(dir, task.task_id, "result.json"));
          found = true;
          break;
        } catch {
          /* doesn't exist in this dir */
        }
      }
      if (found) {
        console.log(
          `${progress} SKIP ${task.task_id} (${task.level}) — already has results`,
        );
        continue;
      }
    }

    console.log(
      `${progress} RUN  ${task.task_id} (${task.level}): ${task.confirmed_task.slice(0, 80)}...`,
    );

    const result = await runNaiveTask(task, config);
    results.push(result);

    if (result.outcome === "success") {
      console.log(
        `${progress} DONE ${task.task_id} — ${result.steps} steps, ${(result.durationMs / 1000).toFixed(1)}s`,
      );
    } else if (result.outcome === "impossible") {
      console.log(
        `${progress} IMPOSSIBLE ${task.task_id} — ${result.steps} steps, ${(result.durationMs / 1000).toFixed(1)}s`,
      );
    } else {
      console.log(`${progress} FAIL ${task.task_id} — ${result.error}`);
      failures.push({ task_id: task.task_id, error: result.error || "unknown" });
    }
  }

  // Write summary
  const completed = results.filter((r) => r.outcome === "success").length;
  const impossible = results.filter((r) => r.outcome === "impossible").length;
  const failed = results.filter((r) => r.outcome === "failure").length;
  const skipped = tasks.length - results.length;
  const ran = results.length;
  const ranExcludingImpossible = ran - impossible;

  const summary = {
    total: tasks.length,
    completed,
    impossible,
    failed,
    skipped,
    model: config.model,
    maxTurns: config.maxTurns,
    failures,
    avgDurationMs: ran
      ? Math.round(results.reduce((s, r) => s + r.durationMs, 0) / ran)
      : 0,
    successRate: ran ? completed / ran : 0,
    successRateExcludingImpossible: ranExcludingImpossible
      ? completed / ranExcludingImpossible
      : 0,
  };

  console.log("");
  console.log(
    `Summary: ${completed} completed, ${impossible} impossible, ${failed} failed, ${skipped} skipped`,
  );
  if (ran > 0) {
    console.log(
      `Average duration: ${(summary.avgDurationMs / 1000).toFixed(1)}s per task`,
    );
    console.log(
      `Success rate: ${(summary.successRate * 100).toFixed(1)}% (${completed}/${ran})`,
    );
    if (impossible > 0) {
      console.log(
        `Success rate (excluding impossible): ${(summary.successRateExcludingImpossible * 100).toFixed(1)}% (${completed}/${ranExcludingImpossible})`,
      );
    }
  }

  // Save failures log
  if (failures.length > 0) {
    await writeFile(
      join(config.outputDir, "failures.json"),
      JSON.stringify(failures, null, 2),
    );
  }

  // Save full results log
  await writeFile(
    join(config.outputDir, "run_summary.json"),
    JSON.stringify(summary, null, 2),
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

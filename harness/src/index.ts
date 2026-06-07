// mind2web/harness/src/index.ts
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "./config.js";
import { runNaiveTask } from "./naive-runner.js";
import { launchAbp, killStraySync, type AbpProcess } from "./abp-process.js";
import type { TaskResult } from "./types.js";
import type { Mind2WebTask } from "./types.js";

/**
 * Resume decision matching the original per-task driver: a task is "done" only
 * if its raw_trace in the output dir recorded a terminal-good outcome (success
 * or impossible). Failures and never-run tasks are (re)run. A task already
 * present as a completed result in an external resultDir is also treated done.
 */
async function taskIsDone(
  outputDir: string,
  resultDirs: string[],
  taskId: string,
): Promise<boolean> {
  try {
    const rt = JSON.parse(
      await readFile(join(outputDir, taskId, "raw_trace.json"), "utf-8"),
    ) as { outcome?: string };
    if (rt.outcome === "success" || rt.outcome === "impossible") return true;
    // A "failure" raw_trace falls through so the task is retried.
  } catch {
    /* no/invalid raw_trace in the output dir */
  }
  for (const dir of resultDirs) {
    try {
      await access(join(dir, taskId, "result.json"));
      return true;
    } catch {
      /* not present in this external set */
    }
  }
  return false;
}

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
    `Running ${tasks.length} tasks (model: ${config.model}, effort: ${config.effort}, max turns: ${config.maxTurns})`,
  );
  console.log(
    `ABP: ${config.manageAbp ? `managed per task (port=${config.abpPort})` : "external (not managed)"}`,
  );
  console.log(`Output: ${config.outputDir}`);
  console.log("");

  // A Ctrl-C must not leave a managed ABP (and its Chrome children) running.
  // Sync kill so it completes inside the signal handler before exiting.
  if (config.manageAbp) {
    process.on("SIGINT", () => {
      console.log("\nInterrupted — killing ABP.");
      killStraySync();
      process.exit(130);
    });
  }

  const results: TaskResult[] = [];
  const failures: Array<{ task_id: string; error: string }> = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const progress = `[${i + 1}/${tasks.length}]`;

    // Resume: skip tasks already finished success/impossible (failures rerun).
    if (
      config.resume &&
      (await taskIsDone(config.outputDir, config.resultDirs, task.task_id))
    ) {
      console.log(
        `${progress} SKIP ${task.task_id} (${task.level}) — already success/impossible`,
      );
      continue;
    }

    console.log(
      `${progress} RUN  ${task.task_id} (${task.level}): ${task.confirmed_task.slice(0, 80)}...`,
    );

    // Per-task ABP lifecycle: a fresh process so browser/GPU state never
    // accumulates across tasks. A launch failure is non-fatal — leave the task
    // un-run so it's retried on the next pass (matching the old bash driver).
    let abp: AbpProcess | null = null;
    if (config.manageAbp) {
      try {
        abp = await launchAbp({
          binPath: config.abpBinPath,
          port: config.abpPort,
          readyTimeoutMs: config.readyTimeoutSec * 1000,
        });
      } catch (e) {
        console.log(
          `${progress} ABP-FAIL ${task.task_id} — ${(e as Error).message} (will retry next run)`,
        );
        continue;
      }
    }

    let result: TaskResult;
    try {
      result = await runNaiveTask(task, config);
    } finally {
      if (abp) await abp.kill();
    }
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
    effort: config.effort,
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

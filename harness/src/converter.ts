// mind2web/harness/src/converter.ts
import { writeFile, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ActionStepV2,
  Mind2WebResultV2,
  TaskTrajectory,
} from "./types.js";

/** Zero-pad a step index to the schema_v2 NNNN.png convention. */
function shotName(step: number): string {
  return `${String(step).padStart(4, "0")}.png`;
}

/**
 * Defensive normalizer: coerce the agent's answer to plain ASCII English.
 *
 * The agent is instructed (SYSTEM_PROMPT + tool descriptions) to emit ASCII
 * only, but models occasionally slip in Unicode punctuation/symbols (and have
 * even emitted mojibake like a replacement char glued to a dash). This is the
 * last-line safety net so result.json never contains bytes > 0x7E. It only
 * normalizes formatting glyphs to ASCII equivalents — it does not change the
 * meaning of the answer.
 */
function toAscii(input: string): string {
  if (!input) return input;
  const map: Record<string, string> = {
    // dashes / hyphens
    "‐": "-", "‑": "-", "‒": "-", "–": "-",
    "—": "-", "―": "-", "−": "-",
    // quotes
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"',
    "′": "'", "″": '"', "«": '"', "»": '"',
    // spaces
    " ": " ", " ": " ", " ": " ", " ": " ",
    " ": " ", " ": " ", " ": " ", "​": "",
    // ellipsis / bullets
    "…": "...", "•": "*", "·": "*", "‣": "*",
    // checks / crosses
    "✓": "[x]", "✔": "[x]", "✗": "[ ]", "✘": "[ ]",
    "✅": "[x]", "❌": "[ ]", "✖": "x",
    // comparison / math
    "≤": "<=", "≥": ">=", "≠": "!=", "×": "x",
    "÷": "/", "±": "+/-",
    // arrows
    "→": "->", "←": "<-", "↔": "<->", "⇒": "=>",
    // currency / misc common
    "€": "EUR", "£": "GBP", "¥": "JPY", "©": "(c)",
    "®": "(r)", "™": "(tm)", "°": " deg",
    "½": "1/2", "¼": "1/4", "¾": "3/4",
    // replacement char (mojibake artifact)
    "�": "",
  };
  // Apply known mappings first.
  let s = input.replace(
    /[‐-―−‘-‟′″«»       ​…•·‣✓✔✗✘✅❌✖≤≥≠×÷±→←↔⇒€£¥©®™°½¼¾�]/g,
    (ch) => map[ch] ?? "",
  );
  // Decompose accents (café -> cafe) then drop any remaining non-ASCII.
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  // Strip any leftover non-ASCII (control chars below 0x20 except \n and \t are
  // also removed to keep the answer clean).
  s = s.replace(/[^\x09\x0A\x20-\x7E]/g, "");
  return s;
}

/**
 * Convert a captured TaskTrajectory into an Online-Mind2Web schema_v2
 * submission (data/schema_v2) and write result.json + trajectory/ screenshots.
 *
 * Trajectory shape (matches example_v2.json):
 *   step 0          : the harness's initial NAVIGATE to the task URL, observing
 *                     the landing page (gives the initial screenshot a home).
 *   steps 1..N      : the agent's actions, post-action 1:1 (one step per action).
 *   step N+1        : terminal TASK_COMPLETE carrying the agent's final answer.
 *
 * Screenshots are copied from the recorder's scratch files into trajectory/
 * with contiguous NNNN.png names so step index == filename order == array
 * index (rules §6.3/§6.4). When an action produced no frame (e.g. a rejected
 * tool call), the previous frame is carried forward so every referenced file
 * exists.
 */
export async function convertAndSave(
  trajectory: TaskTrajectory,
  outputDir: string,
): Promise<string> {
  const taskDir = join(outputDir, trajectory.task.task_id);
  const shotsDir = join(taskDir, "trajectory");
  await mkdir(shotsDir, { recursive: true });

  const entries = trajectory.entries;
  const steps: ActionStepV2[] = [];
  let stepIdx = 0;

  // Carry-forward source: last successfully captured frame (absolute path).
  // Seeded with the initial landing-page frame so step 0 has an image.
  let lastSrc = trajectory.initial_screenshot || "";
  // Carry-forward of the live URL so the terminal TASK_COMPLETE step shows the
  // final page the agent was on (the page its final screenshot depicts).
  let lastUrl: string | null = trajectory.task.website || null;

  // Copy `src` (abs path) into trajectory/<NNNN>.png; tolerate copy failure.
  const place = async (src: string, step: number): Promise<void> => {
    if (!src) return;
    try {
      await copyFile(src, join(shotsDir, shotName(step)));
    } catch {
      /* non-fatal; validator will flag a genuinely missing file */
    }
  };

  // Step 0 — the initial navigation the harness performs before the agent runs.
  // Mirrors example_v2.json's leading NAVIGATE step and homes the initial frame.
  await place(lastSrc, stepIdx);
  steps.push({
    step: stepIdx,
    screenshot: shotName(stepIdx),
    action: `page -> NAVIGATE -> Initial navigation to the provided URL | SUCCESS`,
    url: trajectory.task.website || null,
    action_status: "SUCCESS",
    thought: null,
  });
  stepIdx++;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const src = e.screenshot_path || lastSrc;
    if (e.screenshot_path) lastSrc = e.screenshot_path;
    if (e.url) lastUrl = e.url;
    await place(src, stepIdx);

    steps.push({
      step: stepIdx,
      screenshot: shotName(stepIdx),
      action: e.v2_action || e.action_description || "page -> WAIT -> (no action) | FAILED",
      url: e.url ?? null,
      action_status: e.v2_status ?? null,
      thought: e.thought ? e.thought : null,
    });
    stepIdx++;
  }

  // Terminal TASK_COMPLETE step. Its answer must mirror agent_final_answer.
  // Coerce to plain ASCII as a safety net (the agent is also prompted to do so).
  const answer = toAscii(trajectory.final_response || "");
  const finalSrc = trajectory.final_screenshot || lastSrc;
  await place(finalSrc, stepIdx);
  steps.push({
    step: stepIdx,
    screenshot: shotName(stepIdx),
    action: `TASK_COMPLETE -> ANSWER: ${answer}`,
    url: lastUrl,
    action_status: null,
    thought: null,
  });

  const result: Mind2WebResultV2 = {
    schema_version: "online-mind2web-v2",
    task: trajectory.task.confirmed_task,
    task_id: trajectory.task.task_id,
    agent_final_answer: answer ? answer : null,
    reference_length: trajectory.task.reference_length,
    action_history: steps,
  };

  const resultPath = join(taskDir, "result.json");
  await writeFile(resultPath, JSON.stringify(result, null, 2));
  return resultPath;
}

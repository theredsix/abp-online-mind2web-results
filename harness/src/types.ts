// mind2web/harness/src/types.ts

/** A task from Online_Mind2Web.json */
export interface Mind2WebTask {
  task_id: string;
  confirmed_task: string;
  website: string;
  reference_length: number;
  level: "easy" | "medium" | "hard";
}

/**
 * One self-contained step in an Online-Mind2Web schema_v2 submission.
 * action / screenshot / thought / url all describe the SAME moment, so they
 * cannot desync (the core v1 problem the v2 schema fixes).
 * See Online-Mind2Web/data/schema_v2/{schema_v2.json,README.md}.
 */
export interface ActionStepV2 {
  /** Zero-based; must equal this step's index in action_history. */
  step: number;
  /** Bare filename (no path) under trajectory/. Pattern: NNNN.png. */
  screenshot: string;
  /** Factual action in the v2 action grammar (Grammar A pipe form). */
  action: string;
  /** Page URL at the moment of the action. Recommended; null if unknown. */
  url?: string | null;
  /** Structured mirror of the "| SUCCESS"/"| FAILED" suffix; null if N/A. */
  action_status?: "SUCCESS" | "FAILED" | null;
  /** Reasoning. MUST be present (key always emitted); may be null. */
  thought: string | null;
}

/**
 * result.json document conforming to Online-Mind2Web schema_v2.
 * additionalProperties:false — only these keys are allowed.
 */
export interface Mind2WebResultV2 {
  schema_version: "online-mind2web-v2";
  task: string;
  task_id: string;
  agent_final_answer: string | null;
  reference_length: number;
  action_history: ActionStepV2[];
}

/** A single recorded action in the trajectory (internal capture format). */
export interface TrajectoryEntry {
  step: number;
  action_type: string;
  action_description: string;
  element_descriptor: string | null;
  thought: string;
  /** Absolute path to the post-action screenshot file ("" if none captured). */
  screenshot_path: string;
  timestamp: number;
  /** v2 Grammar A action string (built where the structured action is known). */
  v2_action: string;
  /** v2 per-step status. */
  v2_status: "SUCCESS" | "FAILED" | null;
  /** Destination URL for navigations; null/undefined otherwise. */
  url?: string | null;
}

/** Recorded trajectory for a single task */
export interface TaskTrajectory {
  task: Mind2WebTask;
  entries: TrajectoryEntry[];
  final_response: string;
  result_status: string;
  /** Absolute path to the initial page screenshot (the step-0 observation). */
  initial_screenshot?: string;
  /** Absolute path to a final screenshot for the TASK_COMPLETE step. */
  final_screenshot?: string;
  error?: string;
}

/** Result of running a single task */
export interface TaskResult {
  task_id: string;
  outcome: "success" | "failure" | "impossible";
  steps: number;
  resultPath?: string;
  error?: string;
  durationMs: number;
}

/** Benchmark configuration */
export interface BenchmarkConfig {
  model: string;
  maxTurns: number;
  abpPort: number;
  outputDir: string;
  resultDirs: string[];
  resume: boolean;
  datasetPath: string;
  taskId?: string;
  level?: "easy" | "medium" | "hard";
  limit?: number;
}

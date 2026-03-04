// mind2web/harness/src/types.ts

/** A task from Online_Mind2Web.json */
export interface Mind2WebTask {
  task_id: string;
  confirmed_task: string;
  website: string;
  reference_length: number;
  level: "easy" | "medium" | "hard";
}

/** Output result.json matching mind2web evaluation format */
export interface Mind2WebResult {
  task_id: string;
  task: string;
  final_result_response: string;
  result_status: string;
  action_history: string[];
  thoughts: string[];
}

/** A single recorded action in the trajectory */
export interface TrajectoryEntry {
  step: number;
  action_type: string;
  action_description: string;
  element_descriptor: string | null;
  thought: string;
  screenshot_path: string;
  timestamp: number;
}

/** Recorded trajectory for a single task */
export interface TaskTrajectory {
  task: Mind2WebTask;
  entries: TrajectoryEntry[];
  final_response: string;
  result_status: string;
  error?: string;
}

/** Benchmark configuration */
export interface BenchmarkConfig {
  model: string;
  maxTurns: number;
  abpPort: number;
  outputDir: string;
  resultDirs: string[];
  headless: boolean;
  naive: boolean;
  resume: boolean;
  datasetPath: string;
  taskId?: string;
  level?: "easy" | "medium" | "hard";
  limit?: number;
}

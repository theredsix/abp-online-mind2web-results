// mind2web/harness/src/config.ts
import { type BenchmarkConfig } from "./types.js";

const DEFAULT_CONFIG: BenchmarkConfig = {
  model: "claude-opus-4-6",
  maxTurns: 40,
  abpPort: 8222,
  outputDir: new URL("../../results", import.meta.url).pathname,
  resultDirs: [],
  resume: false,
  datasetPath: new URL("../../Online_Mind2Web.json", import.meta.url).pathname,
};

export function parseConfig(argv: string[]): BenchmarkConfig {
  const config = { ...DEFAULT_CONFIG };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--model":
        config.model = next;
        i++;
        break;
      case "--max-turns":
        config.maxTurns = parseInt(next, 10);
        i++;
        break;
      case "--abp-port":
        config.abpPort = parseInt(next, 10);
        i++;
        break;
      case "--output-dir":
        config.outputDir = next;
        i++;
        break;
      case "--resume":
        config.resume = true;
        break;
      case "--dataset":
        config.datasetPath = next;
        i++;
        break;
      case "--task":
        config.taskId = next;
        i++;
        break;
      case "--level":
        config.level = next as BenchmarkConfig["level"];
        i++;
        break;
      case "--limit":
        config.limit = parseInt(next, 10);
        i++;
        break;
      case "--result-dirs":
        config.resultDirs.push(next);
        i++;
        break;
    }
  }

  return config;
}

// mind2web/harness/src/config.ts
import { type BenchmarkConfig } from "./types.js";

const DEFAULT_CONFIG: BenchmarkConfig = {
  model: "claude-opus-4-8",
  maxTurns: 40,
  effort: "max",
  abpPort: 8222,
  manageAbp: true,
  abpBinPath: "/home/paladin/src/abp-bin/v0.1.10/abp-chrome/abp",
  readyTimeoutSec: 45,
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
      case "--effort":
        config.effort = next as BenchmarkConfig["effort"];
        i++;
        break;
      case "--manage-abp":
        config.manageAbp = true;
        break;
      case "--no-manage-abp":
        config.manageAbp = false;
        break;
      case "--abp-bin":
        config.abpBinPath = next;
        i++;
        break;
      case "--ready-timeout":
        config.readyTimeoutSec = parseInt(next, 10);
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

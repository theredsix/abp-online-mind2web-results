# 🤖 Agent Browser Protocol + Claude on Online Mind2Web

Results from running [agent browser protocol](https://github.com/theredsix/agent-browser-protocol) with Claude on the [Online Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web) benchmark (a web agent benchmark of real-world browser tasks across diverse websites).

## 🆕 Latest run — June 3, 2026 (`claude-opus-4-8`, effort: `max`)

The agent **self-reported** successful completion on **287 of 288** non-impossible tasks — a **99.65%** success rate. These are the agent's own declared outcomes recorded at submission time (`success` / `impossible` / `fail`), **not yet human-verified**.

The full run — per-task `result.json` plus screenshot trajectories for every step — is in [`om2w-submission-6-3-26/`](om2w-submission-6-3-26/) (one folder per task).

> 📌 **Looking for the human-verified results?** Our March 3, 2026 run (`claude-opus-4-6`) was **human-evaluated at 90.53%**, which would top the [public leaderboard](https://huggingface.co/spaces/osunlp/Online_Mind2Web_Leaderboard) (previous leader 78.7%). That run — results, trajectories, and per-task human verdicts — is archived at git tag [`abp-run-v1`](https://github.com/theredsix/abp-online-mind2web-results/tree/abp-run-v1) and can be restored with `git checkout abp-run-v1`. Per-task verdicts: [Google Sheets](https://docs.google.com/spreadsheets/d/1KyeMHCJdSe6G-8zynFNPuWlCfwz7akCUWUiU6ByYEDo/edit?usp=sharing).

## 📊 Results (June 3, 2026 run)

> ⚠️ The numbers below are the **agent's self-reported outcomes** from each task's `raw_trace.json`, not independent human evaluation. Self-reported rates run higher than human-verified ones (the March run self-reported above its human-verified 90.53%). For human-verified results, see the [`abp-run-v1`](#-latest-run--june-3-2026-claude-opus-4-8-effort-max) tag.

### Self-reported success (excluding impossible tasks)

> "Impossible" tasks are ones the agent declared can't be completed (broken sites, tasks requiring accounts that don't exist, features that no longer exist, etc). Tracked separately.

| Level  | Success | Total | Success Rate |
|--------|---------|-------|--------------|
| Easy   | 79      | 79    | 100.00%      |
| Medium | 136     | 137   | 99.27%       |
| Hard   | 72      | 72    | 100.00%      |
| **Total** | **287** | **288** | **99.65%** |

**99.65% overall (self-reported).** 🔥

### Including impossible tasks

| Level  | Success | Total | Success Rate |
|--------|---------|-------|--------------|
| Easy   | 79      | 80    | 98.75%       |
| Medium | 136     | 141   | 96.45%       |
| Hard   | 72      | 79    | 91.14%       |
| **Total** | **287** | **300** | **95.67%** |

### 🔍 Agent outcome breakdown

Each task is classified by the agent at submission: `success` (declared an answer), `impossible` (declared the task can't be done), or `fail` (errored or ran out of steps).

| Level  | ✅ success | 🚫 impossible | ❌ fail |
|--------|-----------|---------------|------------|
| Easy   | 79        | 1             | 0          |
| Medium | 136       | 4             | 1          |
| Hard   | 72        | 7             | 0          |
| **Total** | **287** | **12**       | **1**      |

## 🚀 Run it yourself

Want to see ABP+Claude navigate the web in real time? Here's how to run the benchmark.

### Prerequisites

- Node.js 18+
- An Anthropic API key set as `ANTHROPIC_API_KEY` OR Claude Code OAuth login
- Agent Browser Protocol (ABP) server running on port 8222 (default)

### Install dependencies

```bash
cd harness
npm install
```

### Run

```bash
npm start [options]
```

Or directly:

```bash
cd harness
npx tsx src/index.ts [options]
```

### ⚙️ Options

| Flag | Default | Description |
|------|---------|-------------|
| `--model <name>` | `claude-opus-4-8` | Claude model to use |
| `--effort <level>` | `max` | Reasoning effort level |
| `--max-turns <n>` | `40` | Maximum agent turns per task |
| `--abp-port <n>` | `8222` | Port for the ABP browser server |
| `--abp-bin <path>` | (built-in) | Path to the ABP browser binary (override for your machine) |
| `--no-manage-abp` | (managed) | Don't launch/kill ABP per task; use an externally-running server |
| `--ready-timeout <s>` | `45` | Seconds to wait for ABP to become ready |
| `--output-dir <path>` | `./results` | Directory to write results |
| `--dataset <path>` | `./Online_Mind2Web.json` | Path to dataset file |
| `--level <easy\|medium\|hard>` | (none) | Filter tasks by difficulty |
| `--task <id>` | (none) | Run a single task by ID |
| `--limit <n>` | (none) | Run only the first N tasks |
| `--resume` | `false` | Skip tasks that already finished (success/impossible) |
| `--result-dirs <path>` | (none) | Additional dirs to check when resuming (repeatable) |

### 💡 Examples

```bash
# Run all 300 tasks (grab a coffee ☕)
npm start

# Run only easy tasks with a faster model
npm start --level easy --model claude-haiku-4-5-20251001

# Run a single task to see what it looks like
npm start --task <task_id>

# Resume an interrupted run (no wasted work!)
npm start --resume --output-dir ./results

# Sanity check with 10 tasks first
npm start --limit 10
```

### 📁 Output

Each task writes a `result.json` (final answer + action history) and a `raw_trace.json` (internal outcome: `success`/`impossible`/`failure`) under `<output-dir>/<task_id>/`, alongside a `trajectory/` of step screenshots. After all tasks complete, a `run_summary.json` with aggregate stats is written to the output directory, and any failed tasks are logged to `failures.json`.

## 🙏 Acknowledgements

Huge thanks to the [Online Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web) team at OSU for building such a thorough and genuinely challenging benchmark. It's a great way to stress-test real agentic behavior on the messy, unpredictable real web.

## License

MIT

# Claude on Online Mind2Web

Results from running [agent browser protocol](https://github.com/theredsix/agent-browser-protocol) with opus-4.6 on the [Online Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web) benchmark — a web agent benchmark of real-world browser tasks across diverse websites.

## Results

### Overall (excluding impossible tasks)

| Level  | Passing | Total | Pass Rate |
|--------|---------|-------|-----------|
| Easy   | 75      | 78    | 96.15%    |
| Medium | 124     | 138   | 89.86%    |
| Hard   | 59      | 69    | 85.51%    |
| **Total** | **258** | **285** | **90.53%** |

### Including impossible tasks

| Level  | Passing | Total | Pass Rate |
|--------|---------|-------|-----------|
| Easy   | 75      | 80    | 93.75%    |
| Medium | 124     | 143   | 86.71%    |
| Hard   | 59      | 77    | 76.62%    |
| **Total** | **258** | **300** | **86.00%** |

### Human evaluation breakdown

| Level  | human_eval | Count |
|--------|-----------|-------|
| Easy   | 0 (impossible) | 3  |
| Easy   | 1 (pass)       | 75 |
| Easy   | 2 (fail)       | 2  |
| Medium | 0 (impossible) | 14 |
| Medium | 1 (pass)       | 124|
| Medium | 2 (fail)       | 5  |
| Hard   | 0 (impossible) | 10 |
| Hard   | 1 (pass)       | 59 |
| Hard   | 2 (fail)       | 8  |

Full run details: [Google Sheets](https://docs.google.com/spreadsheets/d/1KyeMHCJdSe6G-8zynFNPuWlCfwz7akCUWUiU6ByYEDo/edit?usp=sharing)

## Running the benchmark

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

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--model <name>` | `claude-opus-4-6` | Claude model to use |
| `--max-turns <n>` | `40` | Maximum agent turns per task |
| `--abp-port <n>` | `8222` | Port for the ABP browser server |
| `--output-dir <path>` | `./results` | Directory to write results |
| `--dataset <path>` | `./Online_Mind2Web.json` | Path to dataset file |
| `--level <easy\|medium\|hard>` | — | Filter tasks by difficulty |
| `--task <id>` | — | Run a single task by ID |
| `--limit <n>` | — | Run only the first N tasks |
| `--resume` | `false` | Skip tasks that already have results |
| `--result-dirs <path>` | — | Additional dirs to check when resuming (repeatable) |

### Examples

```bash
# Run all tasks
npm start

# Run only easy tasks with a faster model
npm start --level easy --model claude-haiku-4-5-20251001

# Run a single task
npm start --task <task_id>

# Resume an interrupted run
npm start --resume --output-dir ./results

# Run with a limit of 10 tasks
npm start --limit 10
```

### Output

Each task writes a `result.json` under `<output-dir>/<task_id>/`. After all tasks complete, a `run_summary.json` is written to the output directory with aggregate stats. Failed tasks are also logged to `failures.json`.

## Acknowledgements

Thanks to the [Online Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web) team for creating such an engaging benchmark.

## License

MIT

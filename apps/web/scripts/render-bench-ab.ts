import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface CliOptions {
  base: string;
  scenario: string;
  rounds: number;
  metric: string;
  warnRegressionPercent: number;
  failRegressionPercent: number;
  minRegressionMs: number;
  headed: boolean;
  outDir: string | null;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const repoRoot = await runText(["git", "rev-parse", "--show-toplevel"], process.cwd());
  if (!repoRoot) throw new Error("Not inside a Git worktree");
  const nodeModules = join(repoRoot, "node_modules");
  if (!(await pathExists(nodeModules))) {
    throw new Error("node_modules is missing; run bun install before the A/B benchmark");
  }

  const worktreeRoot = await mkdtemp(join(tmpdir(), "voidmesh-bench-ab-worktree-"));
  const baseWorktree = join(worktreeRoot, "base");
  const resultRoot = options.outDir
    ? resolve(options.outDir)
    : await mkdtemp(join(tmpdir(), "voidmesh-bench-ab-results-"));
  const baselineOut = join(resultRoot, "baseline");
  const candidateOut = join(resultRoot, "candidate");
  const recordScript = join(repoRoot, "apps/web/scripts/render-bench-record.ts");
  const compareScript = join(repoRoot, "apps/web/scripts/render-bench-compare.ts");
  let worktreeAdded = false;

  try {
    await mkdir(resultRoot, { recursive: true });
    console.log(`Retaining benchmark records in ${resultRoot}`);
    console.log(`Preparing baseline worktree at ${options.base}...`);
    await runChecked(["git", "worktree", "add", "--detach", baseWorktree, options.base], repoRoot);
    worktreeAdded = true;
    await symlink(nodeModules, join(baseWorktree, "node_modules"), "dir");

    console.log(`Running baseline: ${options.scenario} (${options.rounds} rounds)`);
    await runRecord(recordScript, baseWorktree, baselineOut, options);
    console.log(`Running candidate: ${options.scenario} (${options.rounds} rounds)`);
    await runRecord(recordScript, repoRoot, candidateOut, options);

    const comparisonArgs = [
      process.execPath,
      "run",
      compareScript,
      join(baselineOut, "latest.json"),
      join(candidateOut, "latest.json"),
      "--metric",
      options.metric,
      "--warn-regression",
      String(options.warnRegressionPercent),
      "--fail-regression",
      String(options.failRegressionPercent),
      "--min-regression-ms",
      String(options.minRegressionMs),
    ];
    const code = await runStreaming(comparisonArgs, repoRoot);
    console.log(`Baseline record: ${join(baselineOut, "latest.json")}`);
    console.log(`Candidate record: ${join(candidateOut, "latest.json")}`);
    if (code !== 0) process.exitCode = code;
  } finally {
    if (worktreeAdded) {
      await runBestEffort(["git", "worktree", "remove", "--force", baseWorktree], repoRoot);
    }
    await runBestEffort(["git", "worktree", "prune"], repoRoot);
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}

export function parseOptions(argv: readonly string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exit(0);
  }
  const options: CliOptions = {
    base: "main",
    scenario: "",
    rounds: 3,
    metric: "rafIntervalP95Ms",
    warnRegressionPercent: 5,
    failRegressionPercent: 10,
    minRegressionMs: 0.1,
    headed: false,
    outDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--base") {
      options.base = readArg(argv, ++index, arg);
    } else if (arg === "--scenario") {
      options.scenario = readArg(argv, ++index, arg);
    } else if (arg === "--rounds") {
      options.rounds = parsePositiveInteger(readArg(argv, ++index, arg), arg);
    } else if (arg === "--metric") {
      options.metric = readArg(argv, ++index, arg);
    } else if (arg === "--warn-regression") {
      options.warnRegressionPercent = parseNonNegativeNumber(readArg(argv, ++index, arg), arg);
    } else if (arg === "--fail-regression") {
      options.failRegressionPercent = parseNonNegativeNumber(readArg(argv, ++index, arg), arg);
    } else if (arg === "--min-regression-ms") {
      options.minRegressionMs = parseNonNegativeNumber(readArg(argv, ++index, arg), arg);
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--out-dir") {
      options.outDir = readArg(argv, ++index, arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.scenario) throw new Error("--scenario is required; A/B runs must stay bounded");
  if (options.failRegressionPercent < options.warnRegressionPercent) {
    throw new Error("--fail-regression must be greater than or equal to --warn-regression");
  }
  return options;
}

function printUsage(): void {
  console.log(`Usage: bun run bench:render:ab -- --scenario <id> [options]

Runs the selected scenario in a detached base-ref worktree and in the current
working tree, then compares the summaries and retains both JSON records for
targeted follow-up analysis.

Options:
  --base <ref>                 Baseline Git ref (default: main)
  --scenario <id>             Required benchmark scenario
  --rounds <count>            Rounds per side (default: 3)
  --metric <name>             Compare metric (default: rafIntervalP95Ms)
  --warn-regression <percent> Warning threshold (default: 5)
  --fail-regression <percent> Failure threshold (default: 10)
  --min-regression-ms <ms>    Ignore smaller absolute deltas (default: 0.1)
  --headed                     Show Chrome during both runs
  --out-dir <path>            Choose result directory (default: temporary)
  --help                       Show this help`);
}

async function runRecord(
  recordScript: string,
  cwd: string,
  outDir: string,
  options: CliOptions,
): Promise<void> {
  const args = [
    process.execPath,
    "run",
    recordScript,
    "--scenario",
    options.scenario,
    "--rounds",
    String(options.rounds),
    "--out-dir",
    outDir,
  ];
  if (options.headed) args.push("--headed");
  const subprocess = Bun.spawn(args, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (code === 0) return;
  const output = `${stdout}\n${stderr}`.trim().split(/\r?\n/).slice(-40).join("\n");
  throw new Error(`Benchmark failed in ${cwd} with exit code ${code}:\n${output}`);
}

async function runChecked(command: string[], cwd: string): Promise<void> {
  const subprocess = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} failed (${code}):\n${`${stdout}\n${stderr}`.trim()}`);
  }
}

async function runStreaming(command: string[], cwd: string): Promise<number> {
  const subprocess = Bun.spawn(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await subprocess.exited;
}

async function runBestEffort(command: string[], cwd: string): Promise<void> {
  const subprocess = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await subprocess.exited;
}

async function runText(command: string[], cwd: string): Promise<string> {
  const subprocess = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);
  return code === 0 ? stdout.trim() : "";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function readArg(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseNonNegativeNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}

if (import.meta.main) {
  await main();
}

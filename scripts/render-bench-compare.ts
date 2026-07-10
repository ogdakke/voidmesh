interface BenchSummary {
  id: string;
  label: string;
  shaderType: string;
  entityCount: number;
  frames: number;
  sampleCount: number;
  msPerFrame: number;
  cpuEncodeMsPerFrame: number;
  queueDrainMsPerFrame: number;
  p95Ms: number;
  decodedAssetEstimateBytes: number;
  peakResidentBytes: number;
  residentBytes: number;
  sourceBytes: number;
  processedBytes: number;
  sourceTextureCount: number;
  processedTextureCount: number;
  processingTextureBytes: number;
  processingTextureCount: number;
  processingTextureEvictions: number;
  pooledTextureBytes: number;
  pooledTextureCount: number;
  renderedEntitiesPerFrame: number;
  sourceTextureAllocations: number;
  processedTextureAllocations: number;
  sourceUploads: number;
  evictions: number;
}

interface BenchRecord {
  createdAt?: string;
  repo?: {
    branch?: string | null;
    commit?: string | null;
    dirty?: boolean;
  };
  run?: {
    pageUrl?: string;
    scenario?: string | null;
    rounds?: number;
  };
  rounds?: unknown[];
  summary?: BenchSummary[];
}

interface CliOptions {
  baselinePath: string;
  candidatePath: string;
  metric: keyof Omit<BenchSummary, "id" | "label" | "shaderType">;
  warnRegressionPercent: number;
  failRegressionPercent: number;
  minRegressionMs: number;
  json: boolean;
}

interface ComparisonRow {
  id: string;
  label: string;
  baseline: number;
  candidate: number;
  delta: number;
  deltaPercent: number;
  verdict: "pass" | "warn" | "fail";
}

const options = parseOptions(process.argv.slice(2));
const baseline = await readBenchRecord(options.baselinePath);
const candidate = await readBenchRecord(options.candidatePath);
const rows = compareRecords(baseline, candidate, options);
const failed = rows.some((row) => row.verdict === "fail");

if (options.json) {
  console.log(
    JSON.stringify(
      {
        metric: options.metric,
        baseline: describeRecord(baseline),
        candidate: describeRecord(candidate),
        baselineRounds: getRoundCount(baseline),
        candidateRounds: getRoundCount(candidate),
        minRegressionMs: options.minRegressionMs,
        rows,
        failed,
      },
      null,
      2,
    ),
  );
} else {
  printComparison(baseline, candidate, rows, options);
}

if (failed) process.exit(1);

function parseOptions(argv: string[]): CliOptions {
  if (argv.length < 2) {
    throw new Error(
      "Usage: bun run bench:render:compare -- <baseline.json> <candidate.json> [--metric msPerFrame] [--warn-regression 5] [--fail-regression 10]",
    );
  }

  const options: CliOptions = {
    baselinePath: argv[0]!,
    candidatePath: argv[1]!,
    metric: "msPerFrame",
    warnRegressionPercent: 5,
    failRegressionPercent: 10,
    minRegressionMs: 0.1,
    json: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--metric") {
      options.metric = parseMetric(readArgValue(argv, ++index, arg));
    } else if (arg === "--warn-regression") {
      options.warnRegressionPercent = parseNumber(readArgValue(argv, ++index, arg), arg);
    } else if (arg === "--fail-regression") {
      options.failRegressionPercent = parseNumber(readArgValue(argv, ++index, arg), arg);
    } else if (arg === "--min-regression-ms") {
      options.minRegressionMs = parseNumber(readArgValue(argv, ++index, arg), arg);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.failRegressionPercent < options.warnRegressionPercent) {
    throw new Error("--fail-regression must be greater than or equal to --warn-regression");
  }

  return options;
}

function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseMetric(value: string): CliOptions["metric"] {
  const allowed: CliOptions["metric"][] = [
    "msPerFrame",
    "cpuEncodeMsPerFrame",
    "queueDrainMsPerFrame",
    "p95Ms",
    "decodedAssetEstimateBytes",
    "peakResidentBytes",
    "residentBytes",
    "sourceBytes",
    "processedBytes",
    "sourceTextureCount",
    "processedTextureCount",
    "processingTextureBytes",
    "processingTextureCount",
    "processingTextureEvictions",
    "pooledTextureBytes",
    "pooledTextureCount",
    "renderedEntitiesPerFrame",
    "sourceTextureAllocations",
    "processedTextureAllocations",
    "sourceUploads",
    "evictions",
  ];
  if (!allowed.includes(value as CliOptions["metric"])) {
    throw new Error(`Unknown metric "${value}". Use one of: ${allowed.join(", ")}`);
  }
  return value as CliOptions["metric"];
}

function parseNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a positive number`);
  return parsed;
}

async function readBenchRecord(path: string): Promise<BenchRecord> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Bench record not found: ${path}`);
  const parsed = (await file.json()) as BenchRecord;
  if (!Array.isArray(parsed.summary)) throw new Error(`Bench record missing summary: ${path}`);
  return parsed;
}

function compareRecords(
  baseline: BenchRecord,
  candidate: BenchRecord,
  options: CliOptions,
): ComparisonRow[] {
  const baselineById = new Map((baseline.summary ?? []).map((item) => [item.id, item]));
  const candidateById = new Map((candidate.summary ?? []).map((item) => [item.id, item]));
  const commonIds = [...baselineById.keys()].filter((id) => candidateById.has(id));

  if (commonIds.length === 0) {
    throw new Error("Bench records have no common scenario ids");
  }

  return commonIds.map((id) => {
    const baselineSummary = baselineById.get(id)!;
    const candidateSummary = candidateById.get(id)!;
    const baselineValue = baselineSummary[options.metric];
    const candidateValue = candidateSummary[options.metric];
    const delta = candidateValue - baselineValue;
    const deltaPercent = baselineValue === 0 ? 0 : (delta / baselineValue) * 100;
    const verdict =
      delta < options.minRegressionMs
        ? "pass"
        : deltaPercent >= options.failRegressionPercent
          ? "fail"
          : deltaPercent >= options.warnRegressionPercent
            ? "warn"
            : "pass";

    return {
      id,
      label: candidateSummary.label || baselineSummary.label,
      baseline: round(baselineValue),
      candidate: round(candidateValue),
      delta: round(delta),
      deltaPercent: round(deltaPercent),
      verdict,
    };
  });
}

function printComparison(
  baseline: BenchRecord,
  candidate: BenchRecord,
  rows: ComparisonRow[],
  options: CliOptions,
): void {
  console.log(`Metric: ${options.metric}`);
  console.log(`Baseline:  ${describeRecord(baseline)}`);
  console.log(`Candidate: ${describeRecord(candidate)}`);
  console.log(`Rounds: baseline ${getRoundCount(baseline)}, candidate ${getRoundCount(candidate)}`);
  console.log(
    `Thresholds: warn at +${options.warnRegressionPercent}%, fail at +${options.failRegressionPercent}%, minimum +${options.minRegressionMs} ms/frame`,
  );
  console.table(
    rows.map((row) => ({
      id: row.id,
      baseline: row.baseline,
      candidate: row.candidate,
      delta: row.delta,
      "delta %": row.deltaPercent,
      verdict: row.verdict,
    })),
  );
}

function describeRecord(record: BenchRecord): string {
  const commit = record.repo?.commit ? record.repo.commit.slice(0, 12) : "unknown";
  const branch = record.repo?.branch ?? "unknown";
  const dirty = record.repo?.dirty ? " dirty" : "";
  const scenario = record.run?.scenario ? ` ${record.run.scenario}` : " full-suite";
  return `${record.createdAt ?? "unknown-date"} ${branch}@${commit}${dirty}${scenario}`;
}

function getRoundCount(record: BenchRecord): number {
  if (typeof record.run?.rounds === "number") return record.run.rounds;
  if (Array.isArray(record.rounds)) return record.rounds.length;
  return 1;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

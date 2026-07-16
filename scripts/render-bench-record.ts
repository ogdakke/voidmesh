import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface BenchRecord {
  schemaVersion: 4;
  createdAt: string;
  repo: {
    branch: string | null;
    commit: string | null;
    dirty: boolean;
    status: string;
  };
  run: {
    pageUrl: string;
    scenario: string | null;
    suite: "core" | "many-entity";
    headless: boolean;
    rounds: number;
  };
  environment: unknown;
  results: unknown;
  rounds: BenchRoundRecord[];
  summary: BenchSummary[];
}

interface BenchRoundRecord {
  index: number;
  results: unknown[];
  summary: BenchSummary[];
}

interface BenchSummary {
  id: string;
  label: string;
  shaderType: string;
  entityCount: number;
  imageCount: number;
  videoCount: number;
  timingMode: string;
  frames: number;
  sampleCount: number;
  msPerFrame: number;
  cpuEncodeMsPerFrame: number;
  queueDrainMsPerFrame: number;
  sourceUpdateMedianMs: number;
  sourceUpdateP95Ms: number;
  rafIntervalMedianMs: number;
  rafIntervalP95Ms: number;
  rafIntervalMaxMs: number;
  cpuRenderMedianMs: number;
  cpuRenderP95Ms: number;
  cpuRenderMaxMs: number;
  endToEndMedianMs: number;
  endToEndP95Ms: number;
  endToEndMaxMs: number;
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

interface CliOptions {
  scenario: string | null;
  suite: "core" | "many-entity";
  outDir: string;
  port: number;
  cdpPort: number | null;
  headless: boolean;
  keepBrowser: boolean;
  url: string | null;
  disableImmediates: boolean;
  rounds: number;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { message: string; data?: string };
  method?: string;
  params?: unknown;
}

interface RuntimeEvaluateResult {
  result?: {
    type: string;
    value?: unknown;
    description?: string;
  };
  exceptionDetails?: {
    text?: string;
    exception?: {
      description?: string;
      value?: unknown;
    };
  };
}

const HOST = "127.0.0.1";
const DEFAULT_PORT = 5175;

let activeOptions: CliOptions | null = null;
let chromeProfileDir: string | null = null;
let viteProcess: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let chromeProcess: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;

process.on("SIGINT", () => {
  cleanup().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  cleanup().finally(() => process.exit(143));
});

async function main(): Promise<void> {
  const options = await parseOptions(process.argv.slice(2));
  activeOptions = options;
  chromeProfileDir = join(tmpdir(), `voidmesh-render-bench-${process.pid}`);
  const createdAt = new Date().toISOString();

  try {
    const pageUrl = createBenchPageUrl(options);

    if (!options.url) {
      viteProcess = startVite(options.port);
      await waitForHttp(pageUrl, viteProcess);
    }

    const cdpPort = options.cdpPort ?? (await getFreePort());
    const chromePath = await resolveChromePath();
    chromeProcess = startChrome(chromePath, cdpPort, chromeProfileDir, options.headless);
    const pageWebSocketUrl = await openBenchPage(cdpPort, pageUrl);
    const pageClient = await CdpClient.connect(pageWebSocketUrl);

    try {
      await pageClient.send("Runtime.enable");
      const payload = await runBenchInPage(
        pageClient,
        options.scenario,
        options.suite,
        options.rounds,
      );
      const repo = await collectRepoState();
      const rounds = extractRounds(payload);
      const results = rounds.at(-1)?.results ?? [];
      const record: BenchRecord = {
        schemaVersion: 4,
        createdAt,
        repo,
        run: {
          pageUrl,
          scenario: options.scenario,
          suite: options.suite,
          headless: options.headless,
          rounds: options.rounds,
        },
        environment: payload.metadata,
        results,
        rounds,
        summary: summarizeRounds(rounds),
      };

      const outputPath = await writeRecord(record, options.outDir);
      console.log(`Wrote ${outputPath}`);
      console.log(`Rounds: ${record.rounds.length}`);
      console.table(record.summary);
    } finally {
      pageClient.close();
    }
  } finally {
    await cleanup();
  }
}

async function parseOptions(argv: string[]): Promise<CliOptions> {
  const options: CliOptions = {
    scenario: process.env.BENCH_SCENARIO ?? null,
    suite: process.env.BENCH_SUITE === "many-entity" ? "many-entity" : "core",
    outDir: process.env.BENCH_OUT_DIR ?? "bench/results",
    port: Number(process.env.BENCH_PORT ?? DEFAULT_PORT),
    cdpPort: process.env.BENCH_CDP_PORT ? Number(process.env.BENCH_CDP_PORT) : null,
    headless: process.env.BENCH_HEADLESS !== "0",
    keepBrowser: process.env.BENCH_KEEP_BROWSER === "1",
    url: process.env.BENCH_URL ?? null,
    disableImmediates: process.env.BENCH_DISABLE_IMMEDIATES === "1",
    rounds: Number(process.env.BENCH_ROUNDS ?? 1),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--scenario") {
      options.scenario = readArgValue(argv, ++index, arg);
    } else if (arg === "--suite") {
      const suite = readArgValue(argv, ++index, arg);
      if (suite !== "core" && suite !== "many-entity") {
        throw new Error('--suite must be either "core" or "many-entity"');
      }
      options.suite = suite;
    } else if (arg === "--out-dir") {
      options.outDir = readArgValue(argv, ++index, arg);
    } else if (arg === "--port") {
      options.port = Number(readArgValue(argv, ++index, arg));
    } else if (arg === "--cdp-port") {
      options.cdpPort = Number(readArgValue(argv, ++index, arg));
    } else if (arg === "--url") {
      options.url = readArgValue(argv, ++index, arg);
    } else if (arg === "--headed") {
      options.headless = false;
    } else if (arg === "--headless") {
      options.headless = true;
    } else if (arg === "--keep-browser") {
      options.keepBrowser = true;
    } else if (arg === "--disable-immediates") {
      options.disableImmediates = true;
    } else if (arg === "--rounds") {
      options.rounds = Number(readArgValue(argv, ++index, arg));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(options.port) || options.port <= 0) {
    throw new Error(`Invalid --port value: ${options.port}`);
  }
  if (options.cdpPort !== null && (!Number.isFinite(options.cdpPort) || options.cdpPort <= 0)) {
    throw new Error(`Invalid --cdp-port value: ${options.cdpPort}`);
  }
  if (!Number.isInteger(options.rounds) || options.rounds <= 0) {
    throw new Error(`Invalid --rounds value: ${options.rounds}`);
  }

  return options;
}

function readArgValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function createBenchPageUrl(options: CliOptions): string {
  const pageUrl = options.url ?? `http://${HOST}:${options.port}/bench/render.html`;
  if (!options.disableImmediates) return pageUrl;

  const url = new URL(pageUrl);
  url.searchParams.set("shaderImmediates", "0");
  return url.toString();
}

function startVite(port: number): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const subprocess = Bun.spawn(
    ["bun", "run", "vite", "dev", "--host", HOST, "--port", String(port), "--strictPort"],
    {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  void relayOutput(subprocess.stdout, "vite");
  void relayOutput(subprocess.stderr, "vite");
  return subprocess;
}

function startChrome(
  chromePath: string,
  cdpPort: number,
  profileDir: string,
  headless: boolean,
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--window-size=1920,1080",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new");

  const subprocess = Bun.spawn([chromePath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  void relayOutput(subprocess.stdout, "chrome");
  void relayOutput(subprocess.stderr, "chrome");
  return subprocess;
}

async function waitForHttp(
  url: string,
  subprocess: Bun.Subprocess<"ignore", "pipe", "pipe">,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await processExited(subprocess)) !== null) {
      throw new Error("Vite exited before the bench page became available");
    }

    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // Server is not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function openBenchPage(cdpPort: number, pageUrl: string): Promise<string> {
  const version = await waitForJson<{ webSocketDebuggerUrl: string }>(
    `http://${HOST}:${cdpPort}/json/version`,
    20_000,
  );
  const browserClient = await CdpClient.connect(version.webSocketDebuggerUrl);

  try {
    await browserClient.send("Target.createTarget", { url: pageUrl });
  } finally {
    browserClient.close();
  }

  const targets = await waitForJson<Array<{ url: string; webSocketDebuggerUrl?: string }>>(
    `http://${HOST}:${cdpPort}/json/list`,
    10_000,
  );
  const target = targets.find((item) => item.url === pageUrl && item.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("Could not find Chrome DevTools target for the bench page");
  }
  return target.webSocketDebuggerUrl;
}

async function runBenchInPage(
  client: CdpClient,
  scenario: string | null,
  suite: CliOptions["suite"],
  rounds: number,
): Promise<{ metadata: unknown; rounds: Array<{ index: number; results: unknown }> }> {
  const expression = `
    (async () => {
      await new Promise((resolve, reject) => {
        const started = performance.now();
        const poll = () => {
          if (
            typeof window.__collectVoidmeshRenderBenchMetadata === "function" &&
            typeof window.__runVoidmeshRenderBench === "function" &&
            typeof window.__runVoidmeshManyEntityBench === "function" &&
            typeof window.__runVoidmeshRenderBenchScenario === "function"
          ) {
            resolve();
            return;
          }
          if (performance.now() - started > 30000) {
            reject(new Error("Timed out waiting for Voidmesh render bench hooks"));
            return;
          }
          setTimeout(poll, 100);
        };
        poll();
      });
      const metadata = await window.__collectVoidmeshRenderBenchMetadata();
      const scenario = ${JSON.stringify(scenario)};
      const suite = ${JSON.stringify(suite)};
      const roundCount = ${JSON.stringify(rounds)};
      const rounds = [];
      for (let index = 0; index < roundCount; index += 1) {
        const results = scenario
          ? [await window.__runVoidmeshRenderBenchScenario(scenario)]
          : suite === "many-entity"
            ? await window.__runVoidmeshManyEntityBench()
            : await window.__runVoidmeshRenderBench();
        rounds.push({ index, results });
      }
      return { metadata, rounds };
    })()
  `;
  let response: RuntimeEvaluateResult | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = (await client.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })) as RuntimeEvaluateResult;
      break;
    } catch (error) {
      if (attempt === 2 || !isTransientExecutionContextError(error)) throw error;
      await sleep(500);
    }
  }

  if (!response) throw new Error("Bench page did not produce an evaluation response");

  if (response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description ??
      String(response.exceptionDetails.exception?.value ?? response.exceptionDetails.text);
    throw new Error(description);
  }
  if (!response.result || !("value" in response.result)) {
    throw new Error(`Bench did not return a serializable value: ${response.result?.description}`);
  }
  return response.result.value as {
    metadata: unknown;
    rounds: Array<{ index: number; results: unknown }>;
  };
}

function isTransientExecutionContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|Cannot find context with specified id/i.test(message);
}

function extractRounds(payload: {
  rounds: Array<{ index: number; results: unknown }>;
}): BenchRoundRecord[] {
  if (!Array.isArray(payload.rounds)) throw new Error("Bench payload rounds were not an array");
  return payload.rounds.map((round) => {
    if (!Array.isArray(round.results)) {
      throw new Error(`Bench round ${round.index} results were not an array`);
    }
    return {
      index: round.index,
      results: round.results,
      summary: summarizeResults(round.results),
    };
  });
}

function summarizeResults(results: unknown[]): BenchSummary[] {
  return results.map((item) => {
    const result = item as Record<string, unknown>;
    const resources = (result.resources ?? {}) as Record<string, unknown>;
    const entityTextures = (resources.entityTextures ?? {}) as Record<string, unknown>;
    const processingTextures = (resources.processingTextures ?? {}) as Record<string, unknown>;
    const texturePool = (resources.texturePool ?? {}) as Record<string, unknown>;
    const activity = (result.activity ?? {}) as Record<string, unknown>;
    const mediaCounts = (result.mediaCounts ?? {}) as Record<string, unknown>;
    return {
      id: String(result.id),
      label: String(result.label),
      shaderType: String(result.shaderType),
      entityCount: Number(result.entityCount),
      imageCount: Number(mediaCounts.image ?? 0),
      videoCount: Number(mediaCounts.video ?? 0),
      timingMode: String(result.timingMode ?? "batched"),
      frames: Number(result.frames),
      sampleCount: Number(result.sampleCount ?? result.samples),
      msPerFrame: round(Number(result.msPerFrame)),
      cpuEncodeMsPerFrame: round(Number(result.cpuEncodeMsPerFrame)),
      queueDrainMsPerFrame: round(Number(result.queueDrainMsPerFrame)),
      sourceUpdateMedianMs: round(Number(result.sourceUpdateMedianMs ?? 0)),
      sourceUpdateP95Ms: round(Number(result.sourceUpdateP95Ms ?? 0)),
      rafIntervalMedianMs: round(Number(result.rafIntervalMedianMs ?? 0)),
      rafIntervalP95Ms: round(Number(result.rafIntervalP95Ms ?? 0)),
      rafIntervalMaxMs: round(Number(result.rafIntervalMaxMs ?? 0)),
      cpuRenderMedianMs: round(Number(result.cpuRenderMedianMs ?? 0)),
      cpuRenderP95Ms: round(Number(result.cpuRenderP95Ms ?? 0)),
      cpuRenderMaxMs: round(Number(result.cpuRenderMaxMs ?? 0)),
      endToEndMedianMs: round(Number(result.endToEndMedianMs ?? 0)),
      endToEndP95Ms: round(Number(result.endToEndP95Ms ?? 0)),
      endToEndMaxMs: round(Number(result.endToEndMaxMs ?? 0)),
      p95Ms: round(Number(result.p95Ms)),
      decodedAssetEstimateBytes: Number(result.decodedAssetEstimateBytes ?? 0),
      peakResidentBytes: Number(result.peakResidentBytes ?? 0),
      residentBytes: Number(entityTextures.residentBytes ?? 0),
      sourceBytes: Number(entityTextures.sourceBytes ?? 0),
      processedBytes: Number(entityTextures.processedBytes ?? 0),
      sourceTextureCount: Number(entityTextures.sourceTextureCount ?? 0),
      processedTextureCount: Number(entityTextures.processedTextureCount ?? 0),
      processingTextureBytes: Number(processingTextures.residentBytes ?? 0),
      processingTextureCount: Number(processingTextures.entryCount ?? 0),
      processingTextureEvictions: Number(processingTextures.evictions ?? 0),
      pooledTextureBytes: Number(texturePool.residentBytes ?? 0),
      pooledTextureCount: Number(texturePool.textureCount ?? 0),
      renderedEntitiesPerFrame: round(Number(activity.renderedEntitiesPerFrame ?? 0)),
      sourceTextureAllocations: Number(activity.sourceTextureAllocations ?? 0),
      processedTextureAllocations: Number(activity.processedTextureAllocations ?? 0),
      sourceUploads: Number(activity.sourceUploads ?? 0),
      evictions: Number(activity.evictions ?? 0),
    };
  });
}

function summarizeRounds(rounds: readonly BenchRoundRecord[]): BenchSummary[] {
  const byId = new Map<string, BenchSummary[]>();
  for (const round of rounds) {
    for (const summary of round.summary) {
      const summaries = byId.get(summary.id);
      if (summaries) {
        summaries.push(summary);
      } else {
        byId.set(summary.id, [summary]);
      }
    }
  }

  return [...byId.values()].map((summaries) => {
    const first = summaries[0]!;
    return {
      id: first.id,
      label: first.label,
      shaderType: first.shaderType,
      entityCount: first.entityCount,
      imageCount: first.imageCount,
      videoCount: first.videoCount,
      timingMode: first.timingMode,
      frames: first.frames,
      sampleCount: first.sampleCount,
      msPerFrame: round(median(summaries.map((item) => item.msPerFrame))),
      cpuEncodeMsPerFrame: round(median(summaries.map((item) => item.cpuEncodeMsPerFrame))),
      queueDrainMsPerFrame: round(median(summaries.map((item) => item.queueDrainMsPerFrame))),
      sourceUpdateMedianMs: round(median(summaries.map((item) => item.sourceUpdateMedianMs))),
      sourceUpdateP95Ms: round(median(summaries.map((item) => item.sourceUpdateP95Ms))),
      rafIntervalMedianMs: round(median(summaries.map((item) => item.rafIntervalMedianMs))),
      rafIntervalP95Ms: round(median(summaries.map((item) => item.rafIntervalP95Ms))),
      rafIntervalMaxMs: round(median(summaries.map((item) => item.rafIntervalMaxMs))),
      cpuRenderMedianMs: round(median(summaries.map((item) => item.cpuRenderMedianMs))),
      cpuRenderP95Ms: round(median(summaries.map((item) => item.cpuRenderP95Ms))),
      cpuRenderMaxMs: round(median(summaries.map((item) => item.cpuRenderMaxMs))),
      endToEndMedianMs: round(median(summaries.map((item) => item.endToEndMedianMs))),
      endToEndP95Ms: round(median(summaries.map((item) => item.endToEndP95Ms))),
      endToEndMaxMs: round(median(summaries.map((item) => item.endToEndMaxMs))),
      p95Ms: round(median(summaries.map((item) => item.p95Ms))),
      decodedAssetEstimateBytes: median(summaries.map((item) => item.decodedAssetEstimateBytes)),
      peakResidentBytes: median(summaries.map((item) => item.peakResidentBytes)),
      residentBytes: median(summaries.map((item) => item.residentBytes)),
      sourceBytes: median(summaries.map((item) => item.sourceBytes)),
      processedBytes: median(summaries.map((item) => item.processedBytes)),
      sourceTextureCount: median(summaries.map((item) => item.sourceTextureCount)),
      processedTextureCount: median(summaries.map((item) => item.processedTextureCount)),
      processingTextureBytes: median(summaries.map((item) => item.processingTextureBytes)),
      processingTextureCount: median(summaries.map((item) => item.processingTextureCount)),
      processingTextureEvictions: median(summaries.map((item) => item.processingTextureEvictions)),
      pooledTextureBytes: median(summaries.map((item) => item.pooledTextureBytes)),
      pooledTextureCount: median(summaries.map((item) => item.pooledTextureCount)),
      renderedEntitiesPerFrame: round(
        median(summaries.map((item) => item.renderedEntitiesPerFrame)),
      ),
      sourceTextureAllocations: median(summaries.map((item) => item.sourceTextureAllocations)),
      processedTextureAllocations: median(
        summaries.map((item) => item.processedTextureAllocations),
      ),
      sourceUploads: median(summaries.map((item) => item.sourceUploads)),
      evictions: median(summaries.map((item) => item.evictions)),
    };
  });
}

async function writeRecord(record: BenchRecord, outDir: string): Promise<string> {
  const resolvedOutDir = resolve(outDir);
  await mkdir(resolvedOutDir, { recursive: true });
  const commit = record.repo.commit?.slice(0, 12) ?? "unknown";
  const suite = !record.run.scenario && record.run.suite === "many-entity" ? "-many-entity" : "";
  const scenario = record.run.scenario ? `-${record.run.scenario}` : "";
  const timestamp = record.createdAt.replace(/[:.]/g, "-");
  const fileName = `render-bench-${timestamp}-${commit}${suite}${scenario}.json`;
  const outputPath = join(resolvedOutDir, fileName);
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  await Bun.write(outputPath, contents);
  await Bun.write(join(resolvedOutDir, "latest.json"), contents);
  return outputPath;
}

async function collectRepoState(): Promise<BenchRecord["repo"]> {
  const [branch, commit, status] = await Promise.all([
    runText(["git", "rev-parse", "--abbrev-ref", "HEAD"]),
    runText(["git", "rev-parse", "HEAD"]),
    runText(["git", "status", "--short", "--", ".", ":(exclude)node_modules"]),
  ]);
  return {
    branch: branch || null,
    commit: commit || null,
    dirty: status.length > 0,
    status,
  };
}

async function runText(command: string[]): Promise<string> {
  const subprocess = Bun.spawn(command, {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [text, code] = await Promise.all([
    new Response(subprocess.stdout).text(),
    subprocess.exited,
  ]);
  if (code !== 0) return "";
  return text.trim();
}

async function waitForJson<T>(url: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return (await response.json()) as T;
    } catch {
      // Endpoint is not available yet.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function processExited(
  subprocess: Bun.Subprocess<"ignore", "pipe", "pipe">,
): Promise<number | null> {
  const sentinel = Symbol("running");
  const value = await Promise.race([subprocess.exited, sleep(0).then(() => sentinel)]);
  return value === sentinel ? null : Number(value);
}

async function resolveChromePath(): Promise<string> {
  const candidates = [
    process.env.BENCH_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Arc.app/Contents/MacOS/Arc",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter((candidate): candidate is string => !!candidate);

  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error("Could not find Chrome. Set BENCH_CHROME=/path/to/chrome.");
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (typeof address !== "object" || !address) {
        server.close();
        reject(new Error("Could not allocate a free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolvePromise(port));
    });
  });
}

async function relayOutput(stream: ReadableStream<Uint8Array>, label: string): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (line) console.error(`[${label}] ${line}`);
    }
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[index]!;
  return (sorted[index - 1]! + sorted[index]!) / 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function cleanup(): Promise<void> {
  if (viteProcess) viteProcess.kill();
  if (chromeProcess && !activeOptions?.keepBrowser) chromeProcess.kill();
  await Promise.allSettled([viteProcess?.exited, chromeProcess?.exited]);
  if (!activeOptions?.keepBrowser && chromeProfileDir) {
    await rm(chromeProfileDir, { recursive: true, force: true });
  }
}

class CdpClient {
  #nextId = 1;
  #pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  #ws: WebSocket;

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      this.#handleMessage(event.data);
    });
    ws.addEventListener("error", () => {
      this.#rejectAll(new Error("Chrome DevTools websocket error"));
    });
    ws.addEventListener("close", () => {
      this.#rejectAll(new Error("Chrome DevTools websocket closed"));
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      ws.addEventListener("open", () => resolvePromise(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`Could not connect to ${url}`)), {
        once: true,
      });
    });
    return new CdpClient(ws);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const payload = params ? { id, method, params } : { id, method };
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject });
    });
  }

  close(): void {
    this.#ws.close();
  }

  #handleMessage(data: unknown): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as BufferSource);
    const message = JSON.parse(text) as CdpResponse;
    if (!message.id) return;

    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.data ?? message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

await main();

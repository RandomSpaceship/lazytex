// The engine's Web Worker. The app makes it from worker.js (a classic
// worker, because busytex.js loads with importScripts). The client
// (client.ts) sends it the messages of protocol.ts.
//
// The worker loads the engine from the base URL, reads the files of the
// TeX resources with synchronous requests, and never downloads packages.

import { analyzeCompile, analyzeScan, type AnalysisContext, type Outcome } from './analysis';
import { createEngine, type BusytexFactory, type CompileOutput, type Engine, type FormatOutput } from './engine';
import { bundleFileNamesOf, bundlePackagesOf, readTarBundle, type TarBundle } from './filesystem';
import { alternativeFileNames } from './log';
import type { FindScopeResult, InitArguments, InitResult, Progress, ScanResult, WorkerCompileResult, WorkerFormatResult, WorkerMessage, WorkerRequest } from './protocol';
import { scanPreamble } from './scan';
import { buildScopeTable, fileNamesOfIndex, findScopeIn, type TexIndex } from './scope';

declare const self: DedicatedWorkerGlobalScope & { busytex?: BusytexFactory };

let engine: Engine | null = null;
let baseUrl = '';
// The packages that have files in the bundles, and the names of their files
// (AnalysisContext).
let bundlePackages: ReadonlySet<string> = new Set();
let bundleFileNames: ReadonlySet<string> = new Set();
// What a scope change (a second init) uses again: the compiled engine, the
// bundles, and the parsed index files, each by path. The worker keeps the
// indexes of the current scope, and the indexes that findScope() loaded
// until the next scope change.
let wasmModule: Promise<WebAssembly.Module> | null = null;
const bundles = new Map<string, Promise<TarBundle>>();
const indexes = new Map<string, Promise<TexIndex>>();
const fileNames = new Map<string, Set<string>>();

const post = (message: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(message, transfer);
const report = (progress: Progress) => post({ progress });

function fetchSync(url: string): Uint8Array {
  const request = new XMLHttpRequest();
  request.open('GET', url, false);
  request.responseType = 'arraybuffer';
  request.send(null);
  if (request.status !== 200) throw new Error(`GET ${url}: ${request.status}`);
  return new Uint8Array(request.response as ArrayBuffer);
}

// The worker reads only files that the app serves (for example over a
// custom scheme, or from the app's own site), so a report at the start and
// at the end of each file is enough. Package downloads happen in the app,
// which reports their progress.
async function fetchBytes(url: string, stage: Progress['stage']): Promise<Uint8Array> {
  report({ stage, loaded: 0, total: null });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  report({ stage, loaded: bytes.length, total: bytes.length });
  return bytes;
}

// Compile busytex.wasm while it downloads. compileStreaming() needs the
// Content-Type application/wasm. Without it, compile from the bytes, as
// busytex.js would.
async function compileWasm(url: string): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
    return WebAssembly.compile(await response.arrayBuffer());
  }
}

async function fetchJson<T>(url: string, stage: Progress['stage']): Promise<T> {
  report({ stage, loaded: 0, total: null });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
  const text = await response.text();
  report({ stage, loaded: text.length, total: text.length });
  return JSON.parse(text) as T;
}

// A download that the worker keeps. A failed one is not kept: the next
// call tries again.
function kept<T>(promise: Promise<T>, forget: () => void): Promise<T> {
  promise.catch(forget);
  return promise;
}

function loadIndex(path: string): Promise<TexIndex> {
  let index = indexes.get(path);
  if (!index) {
    index = kept(fetchJson<TexIndex>(baseUrl + path, 'index'), () => indexes.delete(path));
    indexes.set(path, index);
  }
  return index;
}

function fileNamesOf(path: string, index: TexIndex): Set<string> {
  let names = fileNames.get(path);
  if (!names) {
    names = fileNamesOfIndex(index);
    fileNames.set(path, names);
  }
  return names;
}

// The generated files of a scope are next to its last index file, in
// generated/<the index's scope>/.
const generatedPrefixOf = (indexPath: string) => indexPath.slice(0, indexPath.lastIndexOf('/') + 1) + 'generated/';

// Start the engine in a scope. A second init (a scope change) drops the
// engine first, and makes a new one from what the worker has: no download
// or parse again, except for index files that it does not have.
function loadBundle(path: string): Promise<TarBundle> {
  let bundle = bundles.get(path);
  if (!bundle) {
    bundle = kept(fetchBytes(baseUrl + path, 'bundle').then(readTarBundle), () => bundles.delete(path));
    bundles.set(path, bundle);
  }
  return bundle;
}

async function init({ baseUrl: newBaseUrl, scope, bundles: bundlePaths, installedPackages }: InitArguments): Promise<InitResult> {
  if (!scope.length) throw new Error('the scope has no index files');
  if (baseUrl && newBaseUrl !== baseUrl) throw new Error('the worker has another baseUrl; make a new worker');
  // The old engine's memory is free when the garbage collector runs.
  engine = null;
  baseUrl = newBaseUrl;
  const startTime = performance.now();
  if (!self.busytex) {
    report({ stage: 'engine', loaded: 0, total: null });
    self.importScripts(baseUrl + 'busytex/busytex.js');
    if (!self.busytex) throw new Error('busytex.js did not define busytex');
  }
  const scriptMs = performance.now() - startTime;

  // The downloads, and the compile of busytex.wasm, run at the same time.
  // Each duration below starts with them.
  const loadStart = performance.now();
  const sinceLoadStart = <T>(promise: Promise<T>): Promise<[T, number]> =>
    promise.then((value) => [value, performance.now() - loadStart]);
  wasmModule ??= kept(compileWasm(`${baseUrl}busytex/busytex.wasm`), () => { wasmModule = null; });
  const [[compiledModule, wasmMs], [scopeIndexes, indexMs], [tarBundles, bundleMs]] = await Promise.all([
    sinceLoadStart(wasmModule),
    sinceLoadStart(Promise.all(scope.map(loadIndex))),
    sinceLoadStart(Promise.all(bundlePaths.map(loadBundle))),
  ]);
  const loadMs = performance.now() - loadStart;
  for (const path of [...indexes.keys()]) {
    if (!scope.includes(path)) {
      indexes.delete(path);
      fileNames.delete(path);
    }
  }

  report({ stage: 'files', loaded: 0, total: null });
  const tableStart = performance.now();
  const scopeTable = buildScopeTable(scopeIndexes, generatedPrefixOf(scope[scope.length - 1]));
  bundlePackages = bundlePackagesOf(tarBundles, scopeTable);
  bundleFileNames = bundleFileNamesOf(tarBundles);
  const tableMs = performance.now() - tableStart;
  engine = await createEngine({
    busytex: self.busytex,
    locateFile: (fileName) => `${baseUrl}busytex/${fileName}`,
    scope: scopeTable,
    baseUrl,
    fetchSync,
    installedPackages,
    bundles: tarBundles,
    wasmModule: compiledModule,
  });
  return {
    scope,
    files: scopeTable.fileCount,
    timings: {
      scriptMs, wasmMs, indexMs, bundleMs, loadMs, tableMs,
      instantiateMs: engine.timings.instantiateMs,
      preloadMs: engine.files.preload?.ms ?? 0,
      registrationMs: engine.files.registrationMs,
      totalMs: performance.now() - startTime,
    },
  };
}

// The first candidate scope that has all the file names. The worker loads a
// candidate's index files only when it gets to that candidate.
async function findScope({ files, candidates }: { files: string[]; candidates: string[][] }): Promise<FindScopeResult> {
  const foundSomewhere = new Set<string>();
  for (const candidate of candidates) {
    const candidateIndexes = await Promise.all(candidate.map(loadIndex));
    const pathOf = new Map(candidateIndexes.map((index, position) => [index, candidate[position]]));
    const { scope, files: missing } = findScopeIn(files, [{ scope: candidate, indexes: candidateIndexes }],
      (index) => fileNamesOf(pathOf.get(index) as string, index), alternativeFileNames);
    if (scope) return { scope, files: [] };
    for (const fileName of files) if (!missing.includes(fileName)) foundSomewhere.add(fileName);
  }
  return { scope: null, files: files.filter((fileName) => !foundSomewhere.has(fileName)) };
}

function analysisContext(current: Engine): AnalysisContext {
  return { isInstalled: (name) => current.files.isInstalled(name), bundlePackages, bundleFileNames };
}

// The outcome of a run.
function outcomeOf(output: CompileOutput | FormatOutput, succeeded: boolean): Outcome {
  const current = engine as Engine;
  return analyzeCompile({ succeeded, log: output.log, terminal: output.stdout, filesFailed: output.filesFailed },
    current.scope, analysisContext(current));
}

// The scan of the preamble, before a run.
function scanOf(source: string): ScanResult {
  const current = requireEngine();
  const operations = scanPreamble(source);
  return { ...(analyzeScan(operations, current.scope, analysisContext(current)) as Exclude<Outcome, { status: 'error' }>), operations };
}

// A result for a run that did not happen, because the scan found needs.
const NO_RUN = { log: null, runMs: 0, filesLoaded: 0, bytesLoaded: 0 };

function runInfo(output: CompileOutput | FormatOutput) {
  return {
    log: output.log,
    runMs: output.runMs,
    filesLoaded: output.filesLoaded.length,
    bytesLoaded: output.filesLoaded.reduce((total, [, size]) => total + size, 0),
  };
}

class EngineCrash extends Error {}

function requireEngine(): Engine {
  if (!engine) throw new Error('the worker has no engine: send init first');
  return engine;
}

function checkCrash(output: CompileOutput | FormatOutput) {
  if (output.crashed) throw new EngineCrash(output.crashed);
}

const handlers = {
  init,
  findScope,

  async scan({ source }: { source: string }): Promise<ScanResult> {
    return scanOf(source);
  },

  async compile({ source, formatName, scan }: { source: string; formatName: string; scan: boolean }): Promise<WorkerCompileResult> {
    const current = requireEngine();
    if (scan) {
      const { operations, ...scanned } = scanOf(source);
      if (scanned.status === 'needs') return { ...scanned, ...NO_RUN, pdf: null, packagesRead: [] };
    }
    const output = current.compile(source, { formatName });
    checkCrash(output);
    const succeeded = output.exitCode === 0 && output.pdf !== null;
    const outcome = outcomeOf(output, succeeded);
    return {
      ...outcome,
      ...runInfo(output),
      pdf: outcome.status === 'ok' ? output.pdf : null,
      packagesRead: output.packagesRead,
    };
  },

  async buildFormat({ formatName, source, mylatexformat, scan }: { formatName: string; source: string; mylatexformat: boolean; scan: boolean }): Promise<WorkerFormatResult> {
    const current = requireEngine();
    if (scan) {
      const { operations, ...scanned } = scanOf(source);
      if (scanned.status === 'needs') return { ...scanned, ...NO_RUN, fmt: null };
    }
    const output = current.buildFormat({ formatName, source, mylatexformat });
    checkCrash(output);
    const outcome = outcomeOf(output, output.exitCode === 0 && output.fmt !== null);
    return { ...outcome, ...runInfo(output), fmt: outcome.status === 'ok' ? output.fmt : null };
  },

  async loadFormat({ formatName, bytes }: { formatName: string; bytes: Uint8Array }) {
    requireEngine().loadFormat(bytes, formatName);
    return {};
  },

  async installPackages({ names }: { names: string[] }) {
    requireEngine().installPackages(names);
    return {};
  },
};

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  const { id, command, args } = data;
  try {
    const handler = handlers[command] as (handlerArguments: unknown) => Promise<unknown>;
    const result = await handler(args);
    const transfer: Transferable[] = [];
    for (const key of ['pdf', 'fmt'] as const) {
      const bytes = (result as Record<string, unknown>)[key];
      if (bytes instanceof Uint8Array) transfer.push(bytes.buffer);
    }
    post({ id, ok: true, result }, transfer);
  } catch (error) {
    post({ id, ok: false, error: String((error as Error)?.stack ?? error), crashed: error instanceof EngineCrash });
  }
};

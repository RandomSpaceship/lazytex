// The library's API for an app: an async client on the main thread that
// runs the engine in a Web Worker (worker.ts).
//
// - The worker starts at start() or at the first compile, and stays alive.
// - One operation runs at a time (also start()). The others wait in order.
//   Only stop() acts at once.
// - After a timeout or an engine abort, the client stops the worker. The
//   next operation starts a new one, with the same scope, packages and
//   formats.
// - The engine never waits for the network. A compile that needs packages
//   returns needs; the app installs them, calls packagesInstalled(), and
//   compiles again. Before each run, the worker scans the preamble, so one
//   needs result gives most packages; scan() gives it without a compile.
//   For files that no loaded index has (needs.files), the app can call
//   findScope(), then setScope(), and compile again.
// - A scope is a list of index files. The library knows no scope names.

import type { NeedReason, Outcome, PackageNeed } from './analysis';
import { normalizeSource } from './normalize';
import type { Operation } from './scan';
import type { FindScopeResult, InitResult, Progress, ScanResult, Scope, WorkerCompileResult, WorkerFormatResult, WorkerMessage, WorkerRequest } from './protocol';

export type { FindScopeResult, NeedReason, Operation, Outcome, PackageNeed, Progress, ScanResult, Scope };
export type { TexError } from './log';
export { normalizeSource } from './normalize';

export interface TexEngineOptions {
  // The URL of the TeX resources (ends with '/'): the release files, and the
  // installed packages at texlive/texmf-dist/. For example a custom scheme
  // of the app, or a folder of the app's own site.
  baseUrl: string;
  // Makes the engine's worker from worker.js, as a classic worker. A worker
  // must come from the app's origin, so the app makes it.
  createWorker: () => Worker;
  // The scope to start in (the app saves it for the device): the paths of its
  // index files below baseUrl, the lowest layer first, for example
  // ['index/index-medium.json'].
  scope: Scope;
  // The bundles to preload: their paths below baseUrl, the lowest layer
  // first, for example ['bundle.tar', 'bundle-my-app.tar']. Default:
  // ['bundle.tar'] (lazytex's bundle, with pdflatex.fmt).
  bundles?: string[];
  // The packages in the package cache.
  installedPackages?: string[];
  // The default time limit of a compile or format build. Default: 60 s.
  timeoutMs?: number;
  // Progress of a worker start (also after setScope).
  onProgress?: (progress: Progress) => void;
}

// 'timeout' and 'crashed' stop the worker; the next operation starts a new one.
type WorkerStoppedResult =
  | { status: 'timeout'; timeoutMs: number }
  | { status: 'crashed'; message: string };

// The result of a compile. 'ok' has the PDF.
export type CompileResult = WorkerCompileResult | WorkerStoppedResult;

// The result of a format build. 'ok' has the format.
export type FormatResult = WorkerFormatResult | WorkerStoppedResult;

class WorkerStopped extends Error {
  constructor(readonly reason: 'timeout' | 'crashed', message: string) {
    super(message);
  }
}

export class TexEngine {
  private worker: Worker | null = null;
  private starting: Promise<InitResult> | null = null;
  private currentScope: Scope;
  private readonly installed: Set<string>;
  private readonly formats = new Map<string, Uint8Array>();
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private manifestHashes: Promise<string> | null = null;
  private readonly options: TexEngineOptions;
  private readonly bundles: string[];

  constructor(options: TexEngineOptions) {
    if (!options.baseUrl.endsWith('/')) throw new Error('baseUrl must end with /');
    if (!options.scope?.length) throw new Error('scope must list at least one index file');
    this.options = options;
    this.bundles = [...(options.bundles ?? ['bundle.tar'])];
    this.currentScope = [...options.scope];
    this.installed = new Set(options.installedPackages ?? []);
  }

  get scope(): Scope {
    return [...this.currentScope];
  }

  // Start the worker now, so that the first compile does not wait for it.
  // The start is an operation in the queue, so it never overlaps another
  // operation (for example setScope()).
  start(): Promise<InitResult> {
    return this.enqueue(() => this.ensureStarted());
  }

  // With scan (the default), the worker scans the preamble first. If the
  // scan finds needs, the result is that `needs` (reason 'scan'), and the
  // engine does not run. Without it, only the log finds needs, for example
  // if the user refused a download that the scan asked for.
  compile(source: string, { format = 'pdflatex', timeoutMs, scan = true }: { format?: string; timeoutMs?: number; scan?: boolean } = {}): Promise<CompileResult> {
    return this.enqueue(async () => {
      await this.ensureStarted();
      return this.runWithLimit<WorkerCompileResult>({ command: 'compile', args: { source, formatName: format, scan } }, timeoutMs);
    });
  }

  // The scan of compile() without a compile: 'ok' or 'needs', and the
  // preamble's loads (operations) for display. The app can install the
  // packages of a note before its first compile.
  scan(source: string): Promise<ScanResult> {
    return this.enqueue(async () => {
      await this.ensureStarted();
      return (await this.request({ command: 'scan', args: { source } })) as ScanResult;
    });
  }

  // Build a format on top of pdflatex.fmt. With mylatexformat, `source` is a
  // LaTeX document whose preamble goes into the format; without it, `source`
  // must end with \dump. On 'ok', the format is loaded, and the client loads
  // it again into a new worker. The app caches `fmt` (see formatKey()).
  // `scan` as for compile(). The scan reads up to \begin{document} or \dump.
  buildFormat(name: string, source: string, { mylatexformat = false, timeoutMs, scan = true }: { mylatexformat?: boolean; timeoutMs?: number; scan?: boolean } = {}): Promise<FormatResult> {
    return this.enqueue(async () => {
      await this.ensureStarted();
      const result = await this.runWithLimit<WorkerFormatResult>({ command: 'buildFormat', args: { formatName: name, source, mylatexformat, scan } }, timeoutMs);
      if (result.status === 'ok') this.formats.set(name, result.fmt.slice());
      return result;
    });
  }

  // Load a format that the app cached.
  loadFormat(name: string, bytes: Uint8Array): Promise<void> {
    this.formats.set(name, bytes.slice());
    return this.enqueue(async () => {
      // In the queue, a worker is always started. Without one, the next
      // start loads the format with the others.
      if (this.worker) await this.request({ command: 'loadFormat', args: { formatName: name, bytes: bytes.slice() } });
    });
  }

  // The app installed these packages in its package cache.
  packagesInstalled(names: string[]): Promise<void> {
    for (const name of names) this.installed.add(name);
    return this.enqueue(async () => {
      // Without a worker, the next start gets the list.
      if (this.worker) await this.request({ command: 'installPackages', args: { names } });
    });
  }

  // Change the scope. A running worker makes a new engine in the new scope
  // from the files that it has, and loads only the index files that it does
  // not have (with progress reports). Without a worker, the next start uses
  // the new scope.
  setScope(scope: Scope): Promise<InitResult | null> {
    if (!scope.length) return Promise.reject(new Error('scope must list at least one index file'));
    return this.enqueue(async () => {
      const same = scope.length === this.currentScope.length && scope.every((path, position) => path === this.currentScope[position]);
      if (same && this.worker) return null;
      this.currentScope = [...scope];
      if (!this.worker) return this.ensureStarted();
      const worker = this.worker;
      const starting = this.initWorker(worker);
      this.starting = starting;
      starting.catch(() => {
        if (this.starting === starting) this.starting = null;
      });
      return starting;
    });
  }

  // The first of the candidate scopes (smallest first) that has all the
  // files, for example the `files` of a needs result, and the files that no
  // candidate has. The worker loads a candidate's index files only when it
  // gets to it, and keeps them until the next scope change.
  findScope(files: string[], candidates: Scope[]): Promise<FindScopeResult> {
    return this.enqueue(async () => {
      await this.ensureStarted();
      return (await this.request({ command: 'findScope', args: { files, candidates } })) as FindScopeResult;
    });
  }

  // A key for the app's format cache (SHA-512, hex): the engine, the bundles
  // and the index files of the release, its upstream versions, and the
  // format's source after normalizeSource() (so a change to a comment keeps
  // the key). A format holds files that it read, so a change to any indexed
  // package must give a new key.
  async formatKey(source: string, { mylatexformat = false }: { mylatexformat?: boolean } = {}): Promise<string> {
    if (!this.manifestHashes) {
      this.manifestHashes = fetch(this.options.baseUrl + 'manifest.json')
        .then((response) => {
          if (!response.ok) throw new Error(`GET manifest.json: ${response.status}`);
          return response.json();
        })
        .then((manifest: { upstream: unknown; files: Record<string, { sha512: string }> }) => [
          // Every index file of the release, so that a scope change keeps the key.
          ...['busytex/busytex.wasm', 'busytex/busytex.js', ...this.bundles,
            ...Object.keys(manifest.files).filter((path) => /^index\/[^/]+\.json$/.test(path)).sort()]
            .map((path) => {
              if (!manifest.files[path]) throw new Error(`manifest.json does not list ${path}`);
              return manifest.files[path].sha512;
            }),
          JSON.stringify(manifest.upstream),
        ].join('\n'));
      // A failed read must not stay in the cache: the next call tries again.
      this.manifestHashes.catch(() => { this.manifestHashes = null; });
    }
    const text = `${await this.manifestHashes}\n${mylatexformat ? 'mylatexformat' : 'dump'}\n${normalizeSource(source)}`;
    const digest = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  // Stop the worker now, also during a compile. The next operation starts a
  // new one.
  stop(): void {
    this.stopWorker();
  }

  // Only for operations in the queue (an operation that called start() would
  // wait for itself).
  private ensureStarted(): Promise<InitResult> {
    if (!this.starting) {
      const starting = this.startWorker();
      this.starting = starting;
      // Do not keep a failed start: the next operation tries again.
      starting.catch(() => {
        if (this.starting === starting) this.starting = null;
      });
    }
    return this.starting;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async startWorker(): Promise<InitResult> {
    const worker = this.options.createWorker();
    this.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if (data.type === 'progress') {
        this.options.onProgress?.(data.progress);
        return;
      }
      const waiting = this.pending.get(data.id);
      if (!waiting) return;
      this.pending.delete(data.id);
      if (data.type === 'result') waiting.resolve(data.result);
      else waiting.reject(data.crashed ? new WorkerStopped('crashed', data.error) : new Error(data.error));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.worker === worker) this.failWorker(new WorkerStopped('crashed', event.message || 'the worker stopped with an error'));
    };
    return this.initWorker(worker);
  }

  // Start the engine in the worker, in the current scope, with the installed
  // packages and the formats. Also for a scope change: the worker drops its
  // engine and makes a new one.
  private async initWorker(worker: Worker): Promise<InitResult> {
    try {
      const result = (await this.request({
        command: 'init',
        args: { baseUrl: this.options.baseUrl, scope: [...this.currentScope], bundles: this.bundles, installedPackages: [...this.installed] },
      })) as InitResult;
      for (const [formatName, bytes] of this.formats) {
        if (this.worker !== worker) throw new WorkerStopped('crashed', 'the worker was stopped');
        await this.request({ command: 'loadFormat', args: { formatName, bytes: bytes.slice() } });
      }
      return result;
    } catch (error) {
      // stop() can stop this worker during its start, and a new worker can
      // start after that. Stop only this worker.
      if (this.worker === worker) this.stopWorker();
      throw error;
    }
  }

  private request(message: Omit<WorkerRequest, 'id'>): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('no worker'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...message, id } as WorkerRequest);
    });
  }

  private async runWithLimit<T>(message: Omit<WorkerRequest, 'id'>, timeoutMs = this.options.timeoutMs ?? 60_000): Promise<T | WorkerStoppedResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      // TeX runs synchronously in the worker, so the only way to stop a run
      // is to stop the worker.
      timer = setTimeout(() => reject(new WorkerStopped('timeout', `no result after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return (await Promise.race([this.request(message), limit])) as T;
    } catch (error) {
      if (!(error instanceof WorkerStopped)) throw error;
      this.stopWorker();
      return error.reason === 'timeout' ? { status: 'timeout', timeoutMs } : { status: 'crashed', message: error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  private failWorker(error: Error) {
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.stopWorker();
  }

  private stopWorker() {
    this.worker?.terminate();
    this.worker = null;
    this.starting = null;
    const stopped = new WorkerStopped('crashed', 'the worker was stopped');
    for (const waiting of this.pending.values()) waiting.reject(stopped);
    this.pending.clear();
  }
}

export function createTexEngine(options: TexEngineOptions): TexEngine {
  return new TexEngine(options);
}

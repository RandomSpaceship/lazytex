// The messages between the client (main thread) and the worker.

import type { Outcome } from './analysis';
import type { Operation } from './scan';

// The build of the library: library/default.nix sets it (esbuild --define)
// from the hash of the sources. client.js and worker.js must come from one
// build, but a cache can keep an old worker.js, so each start compares the
// two.
declare const LIBRARY_BUILD: string;
export const libraryBuild: string = typeof LIBRARY_BUILD === 'string' ? LIBRARY_BUILD : 'unknown';

export const buildMismatchError = (clientBuild: string, workerBuild: string | undefined) =>
  `client.js (build ${clientBuild}) and worker.js (build ${workerBuild ?? 'older, without a build'}) come from different builds: ` +
  'load both from one release, and reload the page without the cache';

// A download of the worker: busytex.wasm (stage 'engine'), an index file
// (also one that findScope() loads), or a bundle. Each download reports its
// start (loaded 0), its bytes while they arrive, and its end (loaded =
// total). The downloads run at the same time, so their reports can mix:
// `file` tells them apart. A scope change reports only what it must load
// again.
export interface DownloadProgress {
  stage: 'engine' | 'index' | 'bundle';
  // The path below the base URL, for example 'bundle.tar'.
  file: string;
  loaded: number;
  // Bytes, or null if not known (the server sent no Content-Length, or
  // compressed the response). The end report always has it.
  total: number | null;
}

// The WebAssembly instance and the file nodes of a start or scope change.
export interface FilesProgress {
  stage: 'files';
}

// The end of a start or scope change: the engine is ready.
export interface StartedProgress {
  stage: 'started';
}

// A file that a compile or a format build read with a request, while TeX
// runs. Nobody knows before the run which files TeX reads, so there is no
// total.
export interface RunProgress {
  stage: 'run';
  // The path below the base URL, for example
  // 'texlive/texmf-dist/tex/latex/tools/calc.sty'.
  file: string;
  // The files of the run up to now, and their bytes.
  filesRead: number;
  bytesRead: number;
}

export type Progress = DownloadProgress | FilesProgress | StartedProgress | RunProgress;

// A scope: the paths of its index files below the base URL, the lowest layer
// first, for example ['index/index-medium.json', 'index/index-full-extra.json'].
export type Scope = string[];

export interface InitArguments {
  baseUrl: string;
  scope: Scope;
  // The paths of the bundles below the base URL, the lowest layer first.
  bundles: string[];
  installedPackages: string[];
  // The client's libraryBuild.
  build: string;
}

export interface InitResult {
  // The worker's libraryBuild.
  build: string;
  scope: Scope;
  files: number;
  timings: Record<string, number>;
}

export interface RunInfo {
  log: string | null;
  runMs: number;
  // Files that the run read through a request, and their bytes.
  filesLoaded: number;
  bytesLoaded: number;
}

type OkOutcome = Extract<Outcome, { status: 'ok' }>;
type OtherOutcome = Exclude<Outcome, { status: 'ok' }>;

export type WorkerCompileResult = RunInfo & {
  // The packages that the compile read. On 'ok', the app can find the
  // mirror packages among them (the ones without a releaseArchive).
  packagesRead: string[];
} & ((OkOutcome & { pdf: Uint8Array }) | (OtherOutcome & { pdf: null }));

export type WorkerFormatResult = RunInfo & ((OkOutcome & { fmt: Uint8Array }) | (OtherOutcome & { fmt: null }));

// The scan of a preamble without a compile: 'ok' or 'needs' (with no
// errors), and the preamble's loads for display.
export type ScanResult = Exclude<Outcome, { status: 'error' }> & { operations: Operation[] };

// scope: the first candidate that has all the files. Else null, and files:
// the files that no candidate has.
export type FindScopeResult =
  | { scope: Scope; files: [] }
  | { scope: null; files: string[] };

export type WorkerRequest =
  | { id: number; command: 'init'; args: InitArguments }
  | { id: number; command: 'findScope'; args: { files: string[]; candidates: Scope[] } }
  | { id: number; command: 'scan'; args: { source: string } }
  // scan: scan the preamble first, and return its `needs` without a run.
  | { id: number; command: 'compile'; args: { source: string; formatName: string; scan: boolean } }
  | { id: number; command: 'buildFormat'; args: { formatName: string; source: string; mylatexformat: boolean; scan: boolean } }
  | { id: number; command: 'loadFormat'; args: { formatName: string; bytes: Uint8Array } }
  | { id: number; command: 'installPackages'; args: { names: string[] } };

export type WorkerMessage =
  | { type: 'result'; id: number; result: unknown }
  // crashed: the engine aborted, and the worker cannot run again.
  | { type: 'error'; id: number; error: string; crashed: boolean }
  | { type: 'progress'; progress: Progress };

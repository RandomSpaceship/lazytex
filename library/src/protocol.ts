// The messages between the client (main thread) and the worker.

import type { Outcome } from './analysis';
import type { Operation } from './scan';

export interface Progress {
  // engine: busytex.js and busytex.wasm; index: the index files (also the
  // ones that findScope() loads); bundle: the bundles; files: the WebAssembly
  // instance and the file nodes. Each stage reports its start (loaded 0,
  // total null). The index and bundle downloads also report their end. The
  // downloads of engine, index and bundle run at the same time, so their
  // reports can mix. A scope change reports only what it must load again.
  stage: 'engine' | 'index' | 'bundle' | 'files';
  // Bytes (characters for the index files).
  loaded: number;
  // The same unit, or null if not known.
  total: number | null;
}

// A scope: the paths of its index files below the base URL, the lowest layer
// first, for example ['index/index-medium.json', 'index/index-full-extra.json'].
export type Scope = string[];

export interface InitArguments {
  baseUrl: string;
  scope: Scope;
  // The paths of the bundles below the base URL, the lowest layer first.
  bundles: string[];
  installedPackages: string[];
}

export interface InitResult {
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

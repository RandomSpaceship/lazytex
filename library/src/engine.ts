// The engine: one BusyTeX pdfTeX instance (engine/) that runs many
// compiles. It is synchronous, so it runs in a Web Worker (worker.ts) or in
// Node (tests and tools).
//
// After each run it undoes what TeX leaves behind, because TeX expects to
// exit after one run:
// - the wasm stack pointer (exit() leaves it lowered);
// - the files that TeX left open;
// - the heap: zero the memory that TeX used, and restore the snapshot of
//   the static data from the start.

import { mountTexFiles, type EmscriptenFS, type FetchSync, type TarBundle, type TexFileSystem } from './filesystem';
import type { ScopeTable } from './scope';

// Node's process object, when the engine runs in Node. The library has no
// Node types, so declare the one property that it uses.
declare const process: { exitCode?: number | string | null } | undefined;

export const WORK_DIRECTORY = '/home/web_user/project';
export const FORMAT_DIRECTORY = '/home/web_user/fmt';

// The busytex factory from busytex.js (Emscripten, MODULARIZE).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BusytexFactory = (moduleArguments: Record<string, unknown>) => Promise<any>;

export function engineEnvironment(): Record<string, string> {
  return {
    // TeX Live's own texmf.cnf (not changed). The variables below replace
    // the paths that it would find from the program's location.
    TEXMFCNF: '/texlive/texmf-dist/web2c',
    TEXMFROOT: '/texlive',
    TEXMFDIST: '/texlive/texmf-dist',
    TEXMFSYSVAR: '/texlive/texmf-var',
    TEXMFSYSCONFIG: '/texlive/texmf-config',
    TEXMFLOCAL: '/texlive/texmf-local',
    TEXMFHOME: '/home/web_user/texmf',
    TEXMFVAR: '/home/web_user/.texlive/texmf-var',
    TEXMFCONFIG: '/home/web_user/.texlive/texmf-config',
    // Fixed timestamps and /ID, so repeated compiles are byte-identical.
    SOURCE_DATE_EPOCH: '1700000000',
    FORCE_SOURCE_DATE: '1',
  };
}

export interface EngineOptions {
  busytex: BusytexFactory;
  locateFile: (fileName: string) => string;
  scope: ScopeTable;
  // The URL that file paths are relative to (ends with '/').
  baseUrl: string;
  fetchSync: FetchSync;
  installedPackages: Iterable<string>;
  // The preloaded bundles, the lowest layer first.
  bundles?: TarBundle[];
  // busytex.wasm, already compiled, so that the compile can run during the
  // other downloads. Without it, busytex.js fetches and compiles the file.
  wasmModule?: WebAssembly.Module | null;
}

export interface RunResult {
  exitCode: number | null;
  // The reason, if the engine aborted. The engine cannot run again.
  crashed: string | null;
  runMs: number;
  resetMs: number;
  // Files that the run read through a request: [path, size].
  filesLoaded: Array<[string, number]>;
  // Files that the run could not read: [path, reason]. TeX read them as
  // empty files, so the output is not correct.
  filesFailed: Array<[string, string]>;
  // Packages of the files that the run opened (from the -recorder list).
  packagesRead: string[];
  log: string | null;
  stdout: string;
  stderr: string;
}

export interface CompileOutput extends RunResult {
  pdf: Uint8Array | null;
}

export interface FormatOutput extends RunResult {
  fmt: Uint8Array | null;
}

export interface Engine {
  scope: ScopeTable;
  files: TexFileSystem;
  timings: { instantiateMs: number; heapBytes: number };
  compile(texSource: string, options?: { formatName?: string }): CompileOutput;
  // Without `source`: pdflatex.fmt from TeX Live's pdflatex.ini. With
  // `source`: a format on top of pdflatex.fmt. With mylatexformat, `source`
  // is a LaTeX document whose preamble goes into the format; without it,
  // `source` must end with \dump.
  buildFormat(options?: { formatName?: string; source?: string | null; mylatexformat?: boolean }): FormatOutput;
  loadFormat(formatBytes: Uint8Array, formatName?: string): void;
  installPackages(names: Iterable<string>): void;
  heapBytes(): number;
}

export async function createEngine(options: EngineOptions): Promise<Engine> {
  const { busytex, locateFile, scope, baseUrl, fetchSync, installedPackages, bundles = [], wasmModule = null } = options;
  const output = { stdout: '', stderr: '' };

  const instantiateStart = performance.now();
  // Emscripten's instantiateWasm hook has no error callback, so a failed
  // instantiation rejects this promise instead.
  let rejectInstantiation: (error: unknown) => void = () => {};
  const instantiationFailed = new Promise<never>((_, reject) => { rejectInstantiation = reject; });
  const Module = await Promise.race([instantiationFailed, busytex({
    thisProgram: '/bin/busytex',
    noInitialRun: true,
    locateFile,
    print: (line: string) => { output.stdout += line + '\n'; },
    printErr: (line: string) => { output.stderr += line + '\n'; },
    preRun: [(emscriptenModule: { ENV: Record<string, string> }) => Object.assign(emscriptenModule.ENV, engineEnvironment())],
    ...(wasmModule ? {
      instantiateWasm(imports: WebAssembly.Imports, receiveInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
        WebAssembly.instantiate(wasmModule, imports).then((instance) => receiveInstance(instance, wasmModule), rejectInstantiation);
        return {};
      },
    } : {}),
  })]);
  const instantiateMs = performance.now() - instantiateStart;
  const FS: EmscriptenFS = Module.FS;
  if (typeof Module._emscripten_get_sbrk_ptr !== 'function') {
    throw new Error('this engine build does not export _emscripten_get_sbrk_ptr; use the engine of the release (lazytex engine/)');
  }

  // Snapshot everything below the allocator's break at the start. After a
  // run, zero from there to the highest break seen: exactly the memory that
  // TeX used, and no other page.
  const breakPointer: number = Module._emscripten_get_sbrk_ptr();
  const currentBreak = () => new Uint32Array(Module.HEAPU8.buffer)[breakPointer >> 2];
  const headerBytes = currentBreak();
  const headerSnapshot: Uint8Array = Module.HEAPU8.slice(0, headerBytes);
  let highestBreak = headerBytes;

  const files = mountTexFiles(FS, { directories: scope.directories, baseUrl, fetchSync, installedPackages, bundles });
  // kpathsea finds SELFAUTO* from the program path, so it must exist.
  FS.mkdirTree('/bin');
  FS.writeFile('/bin/busytex', '');
  FS.mkdirTree(WORK_DIRECTORY);
  FS.mkdirTree(FORMAT_DIRECTORY);
  FS.chdir(WORK_DIRECTORY);

  const flushStdio = () => {
    for (const fileDescriptor of [1, 2]) {
      const stream = FS.streams[fileDescriptor];
      if (stream && stream.tty && stream.tty.output && stream.tty.output.length) stream.tty.ops.fsync(stream.tty);
    }
  };
  const readIfExists = (path: string, encoding?: 'utf8') =>
    FS.analyzePath(path).exists ? FS.readFile(path, encoding ? { encoding } : undefined) : null;
  const unlinkIfExists = (path: string) => { if (FS.analyzePath(path).exists) FS.unlink(path); };

  // The packages of the files in a -recorder list (.fls).
  const packagesOf = (fls: string | null): string[] => {
    const names = new Set<string>();
    for (const line of (fls ?? '').split('\n')) {
      if (!line.startsWith('INPUT ')) continue;
      const file = scope.fileAt(line.slice('INPUT '.length).trim());
      if (file && file.packageName) names.add(file.packageName);
    }
    return [...names].sort();
  };

  let abortReason: string | null = null;

  function run(args: string[], recorderList: string | null): Omit<RunResult, 'log'> {
    if (abortReason) throw new Error('engine aborted earlier: ' + abortReason);
    output.stdout = '';
    output.stderr = '';
    files.takeLoadedFiles();
    files.takeFailedFiles();
    const openBeforeRun = FS.streams.map(Boolean);
    const stackPointer = Module.stackSave();
    // In Node, Emscripten's exit handling sets process.exitCode to TeX's exit
    // status. Keep the host process's own exit code.
    const hostProcess = typeof process === 'object' ? process : null;
    const hostExitCode = hostProcess?.exitCode;
    const runStart = performance.now();
    let exitCode: number | null = null;
    try {
      exitCode = Module.callMain(args.slice());
    } catch (error) {
      // A real crash (abort, RuntimeError): the instance cannot run again.
      abortReason = String(error);
    }
    const runMs = performance.now() - runStart;
    if (hostProcess) hostProcess.exitCode = hostExitCode;
    flushStdio();
    Module.stackRestore(stackPointer);
    FS.streams.forEach((stream: unknown, fileDescriptor: number) => {
      if (stream && !openBeforeRun[fileDescriptor]) FS.close(stream);
    });
    const packagesRead = recorderList ? packagesOf(readIfExists(recorderList, 'utf8')) : [];
    const resetStart = performance.now();
    highestBreak = Math.max(highestBreak, currentBreak());
    Module.HEAPU8.fill(0, headerBytes, highestBreak);
    Module.HEAPU8.set(headerSnapshot);
    return {
      exitCode,
      crashed: abortReason,
      runMs,
      resetMs: performance.now() - resetStart,
      filesLoaded: files.takeLoadedFiles(),
      filesFailed: files.takeFailedFiles(),
      packagesRead,
      stdout: output.stdout,
      stderr: output.stderr,
    };
  }

  return {
    scope,
    files,
    timings: { instantiateMs, heapBytes: Module.HEAPU8.length },

    compile(texSource, { formatName = 'pdflatex' } = {}) {
      for (const extension of ['tex', 'pdf', 'log', 'aux', 'fls']) unlinkIfExists(`${WORK_DIRECTORY}/main.${extension}`);
      FS.writeFile(`${WORK_DIRECTORY}/main.tex`, texSource);
      const result = run(['pdflatex', '-interaction=nonstopmode', '-halt-on-error', '-recorder',
        '-fmt', `${FORMAT_DIRECTORY}/${formatName}.fmt`, 'main.tex'], `${WORK_DIRECTORY}/main.fls`);
      return { ...result, pdf: readIfExists(`${WORK_DIRECTORY}/main.pdf`), log: readIfExists(`${WORK_DIRECTORY}/main.log`, 'utf8') };
    },

    buildFormat({ formatName = 'pdflatex', source = null, mylatexformat = false } = {}) {
      for (const extension of ['fmt', 'log', 'fls']) unlinkIfExists(`${WORK_DIRECTORY}/${formatName}.${extension}`);
      let args: string[];
      if (source === null) {
        // The command line of fmtutil.cnf.
        args = ['pdflatex', '-ini', '-etex', '-interaction=nonstopmode', '-halt-on-error', '-recorder',
          '-translate-file=cp227.tcx', '*pdflatex.ini'];
      } else {
        FS.writeFile(`${WORK_DIRECTORY}/${formatName}.tex`, source);
        args = ['pdflatex', '-ini', '-interaction=nonstopmode', '-halt-on-error', '-recorder', `-jobname=${formatName}`,
          `&${FORMAT_DIRECTORY}/pdflatex`, ...(mylatexformat ? ['mylatexformat.ltx'] : []), `${formatName}.tex`];
      }
      const result = run(args, `${WORK_DIRECTORY}/${source === null ? 'pdflatex' : formatName}.fls`);
      const fmt = readIfExists(`${WORK_DIRECTORY}/${formatName}.fmt`);
      if (fmt) FS.writeFile(`${FORMAT_DIRECTORY}/${formatName}.fmt`, fmt);
      return { ...result, fmt, log: readIfExists(`${WORK_DIRECTORY}/${formatName}.log`, 'utf8') };
    },

    loadFormat(formatBytes, formatName = 'pdflatex') {
      FS.writeFile(`${FORMAT_DIRECTORY}/${formatName}.fmt`, formatBytes);
    },

    installPackages: (names) => files.installPackages(names),
    heapBytes: () => Module.HEAPU8.length,
  };
}

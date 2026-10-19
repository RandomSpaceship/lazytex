// The engine's view of the TeX files, in Emscripten's MEMFS:
//
// - the bundles: preloaded files, as views into the bytes of each tar. A
//   scope can have more than one bundle in layers (for example lazytex's,
//   then an app's), and no two bundles may have the same file;
// - lazy files: a MEMFS file whose size comes from the index, so stat needs
//   no request. The first read fetches the whole file once. If the request
//   fails, the read fails, but TeX takes a failed read as the end of the
//   file. Thus each failure is recorded, and the run's result is an error;
// - lazy directories: a directory gets its entries on its first lookup or
//   readdir. With ls-R, kpathsea opens files by their full path, so only the
//   directories on those paths are made.
//
// Only the files of installed packages (and generated files) get a node.
// The files of other packages are not visible to TeX, so a compile that
// needs them stops with a missing file, and the engine never waits for a
// download.
//
// This uses MEMFS internals (node.contents, node.usedBytes, node_ops,
// stream_ops), not Emscripten's public API.

import { urlPathOf, type DirectoryTable, type FileEntry, type ScopeTable } from './scope';

// Emscripten's FS object. Its internals have no types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EmscriptenFS = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FSNode = any;

const ERRNO_EIO = 29;

export type FetchSync = (url: string) => Uint8Array;

export interface TarBundle {
  // [absolute path, offset, size] of each regular file
  manifest: Array<[string, number, number]>;
  bytes: Uint8Array;
}

// The names (without directories) of the files in the bundles.
export function bundleFileNamesOf(bundles: TarBundle[]): Set<string> {
  return new Set(bundles.flatMap((bundle) => bundle.manifest.map(([path]) => path.slice(path.lastIndexOf('/') + 1))));
}

// The packages that have files in the bundles.
export function bundlePackagesOf(bundles: TarBundle[], scope: ScopeTable): Set<string> {
  const names = new Set<string>();
  for (const bundle of bundles) {
    for (const [path] of bundle.manifest) {
      const packageName = scope.fileAt(path)?.packageName;
      if (packageName) names.add(packageName);
    }
  }
  return names;
}

// Read an uncompressed ustar file (a bundle) into a manifest. The files stay
// views into the same bytes, so nothing is copied. Paths in the tar are
// relative to the file system root.
export function readTarBundle(bytes: Uint8Array): TarBundle {
  const decoder = new TextDecoder();
  const field = (offset: number, length: number) => {
    const raw = bytes.subarray(offset, offset + length);
    const end = raw.indexOf(0);
    return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
  };
  const manifest: TarBundle['manifest'] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    if (bytes.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    if (field(offset + 257, 5) !== 'ustar') throw new Error(`bundle: no ustar header at byte ${offset}`);
    const name = field(offset, 100);
    const prefix = field(offset + 345, 155);
    const size = parseInt(field(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(bytes[offset + 156] || 48);
    const dataOffset = offset + 512;
    if (type === '0') {
      manifest.push(['/' + (prefix ? `${prefix}/${name}` : name), dataOffset, size]);
    } else if (type !== '5') {
      throw new Error(`bundle: tar entry type '${type}' is not supported (${name})`);
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return { manifest, bytes };
}

// A mkdir -p that remembers what it made.
function directoryMaker(FS: EmscriptenFS) {
  const created = new Set<string>(['/']);
  const makeDirectories = (directory: string): void => {
    if (created.has(directory)) return;
    makeDirectories(directory.slice(0, directory.lastIndexOf('/')) || '/');
    // Emscripten makes some directories itself, for example /home/web_user.
    if (!FS.analyzePath(directory).exists) FS.mkdir(directory);
    created.add(directory);
  };
  return { makeDirectories, has: (directory: string) => created.has(directory) };
}

// The callbacks of a lazy file's first read.
interface LoadRecorder {
  loaded(path: string, size: number): void;
  failed(path: string, reason: string): void;
}

function createLazyFile(FS: EmscriptenFS, directory: string, name: string, url: string, size: number,
  fetchSync: FetchSync, recorder: LoadRecorder): FSNode {
  const node = FS.createFile(directory, name, {}, true, false);
  let loaded = false;
  node.contents = null;
  Object.defineProperty(node, 'usedBytes', {
    get() { return loaded ? node.contents.length : size; },
    set() { /* read-only file */ },
    configurable: true,
  });
  const load = () => {
    if (loaded) return;
    let fileBytes: Uint8Array;
    try {
      fileBytes = fetchSync(url);
    } catch (error) {
      recorder.failed(`${directory}/${name}`, error instanceof Error ? error.message : String(error));
      throw new FS.ErrnoError(ERRNO_EIO);
    }
    if (fileBytes.length !== size) {
      recorder.failed(`${directory}/${name}`, `${url} has ${fileBytes.length} bytes, but the index has ${size}`);
      throw new FS.ErrnoError(ERRNO_EIO);
    }
    node.contents = fileBytes;
    loaded = true;
    recorder.loaded(`${directory}/${name}`, size);
  };
  const memfsStreamOps = node.stream_ops;
  node.stream_ops = Object.assign({}, memfsStreamOps, {
    read(stream: unknown, buffer: unknown, offset: number, length: number, position: number) {
      load();
      return memfsStreamOps.read(stream, buffer, offset, length, position);
    },
    mmap(stream: unknown, length: number, position: number, prot: number, flags: number) {
      load();
      return memfsStreamOps.mmap(stream, length, position, prot, flags);
    },
  });
  return node;
}

export interface FileSystemOptions {
  directories: DirectoryTable;
  baseUrl: string;
  fetchSync: FetchSync;
  installedPackages: Iterable<string>;
  // The preloaded bundles, the lowest layer first.
  bundles?: TarBundle[];
}

export interface TexFileSystem {
  preload: { ms: number; files: number; bytes: number } | null;
  registrationMs: number;
  // The files that the current run read through a request: [path, size].
  takeLoadedFiles(): Array<[string, number]>;
  // The files that the current run could not read: [path, reason].
  takeFailedFiles(): Array<[string, string]>;
  installPackages(names: Iterable<string>): void;
  isInstalled(packageName: string): boolean;
  materializedDirectories(): number;
}

export function mountTexFiles(FS: EmscriptenFS, { directories, baseUrl, fetchSync, installedPackages, bundles = [] }: FileSystemOptions): TexFileSystem {
  const { makeDirectories, has } = directoryMaker(FS);
  let loadedFiles: Array<[string, number]> = [];
  // By path: TeX can try to read a file more than once.
  let failedFiles = new Map<string, string>();
  const recorder: LoadRecorder = {
    loaded: (path, size) => { loadedFiles.push([path, size]); },
    failed: (path, reason) => { failedFiles.set(path, reason); },
  };
  const installed = new Set(installedPackages);
  const visible = (file: FileEntry) => file.packageName === null || installed.has(file.packageName);

  // The bundles first. Each file is a view into its tar (canOwn), so nothing
  // is copied.
  let preload: TexFileSystem['preload'] = null;
  if (bundles.length) {
    const startTime = performance.now();
    const preloaded = new Set<string>();
    let totalBytes = 0;
    for (const bundle of bundles) {
      for (const [path, offset, size] of bundle.manifest) {
        if (preloaded.has(path)) throw new Error(`two bundles have ${path}`);
        preloaded.add(path);
        const lastSlash = path.lastIndexOf('/');
        const directory = path.slice(0, lastSlash);
        makeDirectories(directory);
        FS.createDataFile(directory, path.slice(lastSlash + 1), bundle.bytes.subarray(offset, offset + size), true, false, true);
        totalBytes += size;
      }
    }
    preload = { ms: performance.now() - startTime, files: preloaded.size, bytes: totalBytes };
  }

  const registrationStart = performance.now();
  const materialized = new Set<string>();
  const memfsDirectoryOps = FS.lookupPath('/').node.node_ops;
  const lazyDirectoryOps = Object.assign({}, memfsDirectoryOps, {
    lookup(parent: FSNode, name: string) {
      if (parent.lazyDirectory) {
        materialize(parent);
        return FS.lookupNode(parent, name);
      }
      return memfsDirectoryOps.lookup(parent, name);
    },
    readdir(node: FSNode) {
      if (node.lazyDirectory) materialize(node);
      return memfsDirectoryOps.readdir(node);
    },
  });
  const makeLazy = (node: FSNode, directory: string) => {
    node.lazyDirectory = directory;
    node.node_ops = lazyDirectoryOps;
  };
  // Make the entries of one directory. Clear the mark first: creating an
  // entry looks up its name, which must not start this again.
  function materialize(node: FSNode) {
    const directory: string = node.lazyDirectory;
    node.lazyDirectory = null;
    materialized.add(directory);
    for (const [name, file] of directories.get(directory) as Map<string, FileEntry | null>) {
      const existing = node.contents[name];
      if (file) {
        if (!existing && visible(file)) createLazyFile(FS, directory, name, baseUrl + urlPathOf(`${directory}/${name}`, file), file.size, fetchSync, recorder);
      } else {
        const childPath = `${directory}/${name}`;
        makeLazy(existing || FS.mkdir(childPath), childPath);
      }
    }
  }
  // The top directories of the table, and each directory that the bundle
  // made, become lazy directories. Only existing paths are looked up here, so
  // no lookup reaches a lazy directory.
  for (const directory of directories.keys()) {
    const parent = directory.slice(0, directory.lastIndexOf('/'));
    if (!directories.has(parent)) makeDirectories(directory);
  }
  for (const directory of directories.keys()) {
    if (has(directory)) makeLazy(FS.lookupPath(directory).node, directory);
  }
  const registrationMs = performance.now() - registrationStart;

  return {
    preload,
    registrationMs,
    takeLoadedFiles() {
      const files = loadedFiles;
      loadedFiles = [];
      return files;
    },
    takeFailedFiles() {
      const files = [...failedFiles];
      failedFiles = new Map();
      return files;
    },
    // New packages are visible at once. A directory that is already made gets
    // its new files now; the others get them when they are made.
    installPackages(names) {
      const added = new Set<string>();
      for (const name of names) {
        if (!installed.has(name)) {
          installed.add(name);
          added.add(name);
        }
      }
      if (!added.size) return;
      for (const directory of materialized) {
        for (const [name, file] of directories.get(directory) as Map<string, FileEntry | null>) {
          if (!file || file.packageName === null || !added.has(file.packageName)) continue;
          if (!FS.lookupPath(directory).node.contents[name]) {
            createLazyFile(FS, directory, name, baseUrl + urlPathOf(`${directory}/${name}`, file), file.size, fetchSync, recorder);
          }
        }
      }
    },
    isInstalled: (packageName) => installed.has(packageName),
    materializedDirectories: () => materialized.size,
  };
}

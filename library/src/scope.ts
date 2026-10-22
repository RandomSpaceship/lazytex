// The files that the engine can see in a scope, built directly from the
// index files (docs/formats.md). The table holds directory entries, so
// that the lazy directories need no other pass over the files.

export interface ReleaseArchive {
  // An absolute URL: a GitHub release asset, in this release or another one.
  url: string;
  bytes: number;
  sha512: string;
}

// A file's size, or for an entry file whose measured set differs from its
// package's `loads`, its size and that set.
export type IndexFile = number | { bytes: number; loads: string[] };

export const fileBytes = (file: IndexFile): number => (typeof file === 'number' ? file : file.bytes);

export interface IndexPackage {
  revision: number;
  archiveBytes: number;
  sha512: string;
  releaseArchive?: ReleaseArchive;
  depends?: string[];
  // Only in measured packages, and then also when it is empty.
  loads?: string[];
  files: Record<string, IndexFile>;
}

export interface TexIndex {
  format: 'lazytex-index';
  version: 1;
  // The name of this layer, for example 'medium' or 'full-extra'.
  scope: string;
  // The layer under this one, if there is one.
  extends?: string;
  texlive: { year: number; revision: number; frozen: boolean };
  trees?: { 'texmf-dist': string; 'texmf-var': string };
  packages: Record<string, IndexPackage>;
  generated: Record<string, Record<string, number>>;
}

// A file in the table. `packageName` is null for a generated file.
export interface FileEntry {
  size: number;
  // The path below the base URL, without a leading '/'. Only generated files
  // have it: a package file's URL path is its path without the leading '/'.
  urlPath?: string;
  packageName: string | null;
}

// The path below the base URL of the file at an absolute path.
export const urlPathOf = (path: string, file: FileEntry): string => file.urlPath ?? path.slice(1);

// directory path -> (name -> file entry, or null for a subdirectory)
export type DirectoryTable = Map<string, Map<string, FileEntry | null>>;

export interface ScopeTable {
  indexes: TexIndex[];
  packages: Map<string, IndexPackage>;
  directories: DirectoryTable;
  fileCount: number;
  totalBytes: number;
  // The file at an absolute path, or undefined.
  fileAt(path: string): FileEntry | undefined;
  // The packages that have a file with this name (the last part of a path).
  packagesWithFileName(name: string): string[];
}

export function checkIndex(index: TexIndex): void {
  if (index.format !== 'lazytex-index' || index.version !== 1) {
    throw new Error(`not a lazytex-index version 1 file: ${index.format} ${index.version}`);
  }
}

// indexes: the index files of a scope, the lowest layer first (it has the
// trees), for example [index-medium.json, index-full-extra.json]. Generated
// files belong to the scope, so they come from the last index, at
// <generatedPrefix><its scope>/<tree>/<path>.
export function buildScopeTable(indexes: TexIndex[], generatedPrefix = 'index/generated/'): ScopeTable {
  indexes.forEach(checkIndex);
  const trees = indexes[0].trees;
  if (!trees) throw new Error('the first index must be index-medium.json (it has the trees)');
  const directories: DirectoryTable = new Map();
  const entriesFor = (directory: string): Map<string, FileEntry | null> => {
    let entries = directories.get(directory);
    if (!entries) {
      entries = new Map();
      directories.set(directory, entries);
      const lastSlash = directory.lastIndexOf('/');
      if (lastSlash > 0) entriesFor(directory.slice(0, lastSlash)).set(directory.slice(lastSlash + 1), null);
    }
    return entries;
  };
  const addFile = (path: string, entry: FileEntry) => {
    const lastSlash = path.lastIndexOf('/');
    entriesFor(path.slice(0, lastSlash)).set(path.slice(lastSlash + 1), entry);
  };

  const packages = new Map<string, IndexPackage>();
  let fileCount = 0;
  let totalBytes = 0;
  const distRoot = trees['texmf-dist'];
  for (const index of indexes) {
    for (const [packageName, packageEntry] of Object.entries(index.packages)) {
      packages.set(packageName, packageEntry);
      // A package's files are in few directories, and in order, so find each
      // directory once for a row of files in it.
      let lastDirectory: string | null = null;
      let entries: Map<string, FileEntry | null> | null = null;
      for (const relativePath in packageEntry.files) {
        const size = fileBytes(packageEntry.files[relativePath]);
        const lastSlash = relativePath.lastIndexOf('/');
        const directory = lastSlash === -1 ? '' : relativePath.slice(0, lastSlash);
        if (directory !== lastDirectory || !entries) {
          entries = entriesFor(directory ? `${distRoot}/${directory}` : distRoot);
          lastDirectory = directory;
        }
        entries.set(relativePath.slice(lastSlash + 1), { size, packageName });
        fileCount += 1;
        totalBytes += size;
      }
    }
  }
  const generatedIndex = indexes[indexes.length - 1];
  for (const [tree, entries] of Object.entries(generatedIndex.generated)) {
    const treeRoot = trees[tree as keyof typeof trees];
    for (const [relativePath, size] of Object.entries(entries)) {
      addFile(`${treeRoot}/${relativePath}`, {
        size, urlPath: `${generatedPrefix}${generatedIndex.scope}/${tree}/${relativePath}`, packageName: null,
      });
      fileCount += 1;
      totalBytes += size;
    }
  }

  let packagesByFileName: Map<string, string[]> | null = null;
  return {
    indexes,
    packages,
    directories,
    fileCount,
    totalBytes,
    fileAt(path) {
      const lastSlash = path.lastIndexOf('/');
      return directories.get(path.slice(0, lastSlash))?.get(path.slice(lastSlash + 1)) ?? undefined;
    },
    packagesWithFileName(name) {
      // Made on first use: a scan that finds a file outside the bundle, or a
      // compile with a missing file.
      if (!packagesByFileName) packagesByFileName = packagesByFileNameOf(indexes);
      return packagesByFileName.get(name) ?? [];
    },
  };
}

// The owners of each file name. pdfLaTeX finds a file in tex/latex-dev/ only
// if tex/latex/ and tex/generic/ do not have it (TEXINPUTS.pdflatex in
// texmf.cnf), so the latex-dev packages (for example latex-tools-dev) come
// last.
export function packagesByFileNameOf(indexes: TexIndex[]): Map<string, string[]> {
  const byName = new Map<string, string[]>();
  const devOwners = new Map<string, string[]>();
  for (const index of indexes) {
    for (const [packageName, packageEntry] of Object.entries(index.packages)) {
      for (const relativePath of Object.keys(packageEntry.files)) {
        const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
        const table = relativePath.startsWith('tex/latex-dev/') ? devOwners : byName;
        const owners = table.get(name);
        if (!owners) table.set(name, [packageName]);
        else if (!owners.includes(packageName)) owners.push(packageName);
      }
    }
  }
  for (const [name, owners] of devOwners) {
    const others = byName.get(name) ?? [];
    byName.set(name, [...others, ...owners.filter((owner) => !others.includes(owner))]);
  }
  return byName;
}

// The first of the candidate scopes (each the index files of a scope,
// smallest first) whose indexes have all the file names. A file name
// matches if one of its forms (alternativeFileNames()) is in the scope.
// `files`: the names that no candidate has. `fileNamesOf` gives the file
// names of one index, so that the worker can keep them.
export function findScopeIn<T>(fileNames: string[], candidates: Array<{ scope: T; indexes: TexIndex[] }>,
  fileNamesOf: (index: TexIndex) => ReadonlySet<string> = fileNamesOfIndex,
  alternativesOf: (fileName: string) => string[] = (fileName) => [fileName]): { scope: T; files: [] } | { scope: null; files: string[] } {
  const foundSomewhere = new Set<string>();
  for (const { scope, indexes } of candidates) {
    const nameSets = indexes.map(fileNamesOf);
    const missing = fileNames.filter((fileName) => !alternativesOf(fileName).some((name) => nameSets.some((names) => names.has(name))));
    for (const fileName of fileNames) if (!missing.includes(fileName)) foundSomewhere.add(fileName);
    if (!missing.length) return { scope, files: [] };
  }
  return { scope: null, files: fileNames.filter((fileName) => !foundSomewhere.has(fileName)) };
}

// The file names (the last part of each path) of an index's packages.
export function fileNamesOfIndex(index: TexIndex): Set<string> {
  const names = new Set<string>();
  for (const packageEntry of Object.values(index.packages)) {
    for (const relativePath of Object.keys(packageEntry.files)) names.add(relativePath.slice(relativePath.lastIndexOf('/') + 1));
  }
  return names;
}

// The packages in `names` and all packages that they depend on.
export function dependencyClosure(names: Iterable<string>, packages: Map<string, IndexPackage>): string[] {
  const result = new Set<string>();
  const pending = [...names];
  while (pending.length) {
    const name = pending.pop() as string;
    if (result.has(name)) continue;
    const packageEntry = packages.get(name);
    if (!packageEntry) continue;
    result.add(name);
    pending.push(...(packageEntry.depends ?? []));
  }
  return [...result].sort();
}

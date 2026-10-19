// What a compile result means for the app (library/README.md, "Results").

import { missingFileCandidates, texErrors, type TexError } from './log';
import { fileCandidatesOf, type Operation } from './scan';
import type { IndexPackage, ScopeTable } from './scope';

// Why a package is in a `needs` result, in order of priority:
// scan: the scan of the preamble found a file of it;
// log: TeX stopped because a file of it was missing;
// loads: a measured record of another package lists it;
// depends: the `depends` closure of another package lists it.
export type NeedReason = 'scan' | 'log' | 'loads' | 'depends';

export interface PackageNeed {
  name: string;
  reason: NeedReason;
  // For 'scan' and 'log': the file names that caused it.
  files?: string[];
  // For 'loads' and 'depends': one package that needs it (the first that
  // the library found). The app can follow the chain back to a file.
  requiredBy?: string;
}

export type Outcome =
  | { status: 'ok' }
  // packages: install them, call packagesInstalled(), and compile again.
  // files: file names that no loaded index has.
  // errors: TeX's errors, for when no scope has the files (empty after a scan).
  | { status: 'needs'; packages: PackageNeed[]; files: string[]; errors: TexError[] }
  | { status: 'error'; errors: TexError[] };

export interface AnalysisContext {
  // Whether a package is in the package cache.
  isInstalled: (packageName: string) => boolean;
  // The packages that have files in the preloaded bundles. A closure does not
  // list them: the bundles have the files that their usual documents read. If
  // a document needs another file of one of them, the log names it.
  bundlePackages?: ReadonlySet<string>;
  // The names of the files in the bundles. The scan does not ask for a file
  // that a bundle has.
  bundleFileNames?: ReadonlySet<string>;
}

const REASON_ORDER: NeedReason[] = ['scan', 'log', 'loads', 'depends'];

// The measured set for a missing file: the file's own record, else its
// package's record. Null if the package was not measured.
function measuredLoads(packageEntry: IndexPackage, fileName: string): string[] | null {
  for (const relativePath in packageEntry.files) {
    const file = packageEntry.files[relativePath];
    if (typeof file !== 'number' && relativePath.endsWith('/' + fileName)) return file.loads;
  }
  return packageEntry.loads ?? null;
}

// The packages that the missing files need. `direct` has the package of
// each missing file, with the file names, and `directReason` says how the
// library found them (the scan or the log). Lookup for each file: its record,
// else its package's record, else the `depends` closure of its package. A
// measured package in a `depends` closure adds its record, and the closure
// does not go further through it (a record is the complete set).
export function packageNeeds(direct: Map<string, string[]>, scope: ScopeTable,
  { isInstalled, bundlePackages = new Set() }: AnalysisContext, directReason: 'scan' | 'log' = 'log'): PackageNeed[] {
  const needs = new Map<string, PackageNeed>();
  const add = (need: PackageNeed) => {
    const existing = needs.get(need.name);
    if (!existing || REASON_ORDER.indexOf(need.reason) < REASON_ORDER.indexOf(existing.reason)) needs.set(need.name, need);
  };
  for (const [name, files] of direct) add({ name, reason: directReason, files });
  // A record was measured in lazytex's full scope, so it can name packages
  // that a smaller scope does not have. Those are not in the result: the log
  // finds the file, and the app can change the scope (findScope()).
  const addLoads = (loads: string[], requiredBy: string) => {
    for (const name of loads) if (scope.packages.has(name)) add({ name, reason: 'loads', requiredBy });
  };
  for (const [name, files] of direct) {
    const packageEntry = scope.packages.get(name) as IndexPackage;
    const fileSets = files.map((fileName) => measuredLoads(packageEntry, fileName));
    for (const loads of fileSets) if (loads) addLoads(loads, name);
    if (fileSets.every((loads) => loads)) continue;
    // Not measured: walk the depends closure, breadth first, so that
    // requiredBy is the nearest package.
    const visited = new Set([name]);
    const pending = [name];
    while (pending.length) {
      const parent = pending.shift() as string;
      for (const dependency of scope.packages.get(parent)?.depends ?? []) {
        if (visited.has(dependency) || !scope.packages.has(dependency)) continue;
        visited.add(dependency);
        add({ name: dependency, reason: 'depends', requiredBy: parent });
        const dependencyEntry = scope.packages.get(dependency) as IndexPackage;
        if (dependencyEntry.loads) addLoads(dependencyEntry.loads, dependency);
        else pending.push(dependency);
      }
    }
  }
  return [...needs.values()]
    .filter((need) => !isInstalled(need.name) && (need.reason === directReason || !bundlePackages.has(need.name)))
    .sort((a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// The package of each file that is not available, from candidate lists (the
// names to look for, in order of preference). A file is available if a
// package that has it is installed, or if `isPreloaded` says so. unknownFiles:
// the first candidate of each file that no loaded index has.
function directPackages(candidateLists: string[][], scope: ScopeTable, isInstalled: (packageName: string) => boolean,
  isPreloaded: (fileName: string) => boolean = () => false) {
  const direct = new Map<string, string[]>();
  const unknownFiles: string[] = [];
  const seen = new Set<string>();
  for (const candidates of candidateLists) {
    // The log and the terminal output usually report the same file.
    const key = candidates.join('\n');
    if (seen.has(key)) continue;
    seen.add(key);
    // A preloaded file is available. The bundle has the files that TeX read,
    // so if it has one candidate (pgflibraryX for tikzlibraryX), TeX does not
    // find an earlier one. This check comes first, so that a scan of a bundle
    // document does not make the file-name table.
    if (candidates.some(isPreloaded)) continue;
    let found = false;
    for (const name of candidates) {
      const owners = scope.packagesWithFileName(name);
      if (!owners.length) continue;
      found = true;
      // Most names have one package. If several have it, and one is already
      // installed, the file is available.
      if (owners.some(isInstalled)) break;
      direct.set(owners[0], [...(direct.get(owners[0]) ?? []), name]);
      break;
    }
    if (!found && !unknownFiles.includes(candidates[0])) unknownFiles.push(candidates[0]);
  }
  return { direct, unknownFiles };
}

// The outcome of the scan (scanPreamble()): `needs` if a file that the
// preamble names is not available, or if no loaded index has it. Files in
// the bundle are available. The closures are as for the log.
export function analyzeScan(operations: Operation[], scope: ScopeTable, context: AnalysisContext): Outcome {
  const { isInstalled, bundleFileNames = new Set() } = context;
  const { direct, unknownFiles } = directPackages(operations.flatMap(fileCandidatesOf), scope, isInstalled,
    (fileName) => bundleFileNames.has(fileName));
  if (!direct.size && !unknownFiles.length) return { status: 'ok' };
  return { status: 'needs', packages: packageNeeds(direct, scope, context, 'scan'), files: unknownFiles, errors: [] };
}

// succeeded: the compile made a PDF with exit code 0.
// terminal: TeX's terminal output, for a failure without a log.
// filesFailed: the files that the run could not read, as [path, reason]. TeX
// read them as empty files, so the result is an error, also if TeX succeeded.
export function analyzeCompile(
  { succeeded, log, terminal = null, filesFailed = [] }:
    { succeeded: boolean; log: string | null; terminal?: string | null; filesFailed?: Array<[string, string]> },
  scope: ScopeTable,
  context: AnalysisContext,
): Outcome {
  if (filesFailed.length) {
    const readErrors = filesFailed.map(([path, reason]) => ({ message: `could not read ${path}: ${reason}`, line: null, context: '' }));
    return { status: 'error', errors: [...readErrors, ...texErrors(log)] };
  }
  if (succeeded) return { status: 'ok' };
  // A fatal pdfTeX error (for example a missing Type 1 font) can be only in
  // the terminal output. A file that no loaded index has: the app can look
  // for it in other scopes (findScope()).
  const { direct, unknownFiles } = directPackages(missingFileCandidates(`${log ?? ''}\n${terminal ?? ''}`), scope, context.isInstalled);
  const errors = texErrors(log);
  if (direct.size || unknownFiles.length) {
    return { status: 'needs', packages: packageNeeds(direct, scope, context), files: unknownFiles, errors };
  }
  if (!errors.length) {
    // No error in the log, or no log: TeX stopped before it could write one
    // (for example a format that does not load). Its terminal output says why.
    const lastLines = (terminal ?? '').trim().split('\n').slice(-5).join('\n');
    errors.push({ message: lastLines || 'the compile failed, and TeX gave no message', line: null, context: '' });
  }
  return { status: 'error', errors };
}

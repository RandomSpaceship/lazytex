// Measure the packages that each entry file of a package reads
// (docs/formats.md, "Measured loads"). For each entry file of each measured
// package, compile a small document in a scope (lazytex: the full scope) with
// all packages installed, and record the packages that the run opened.
//
// Entry files and their documents:
//   <name>.sty                   \usepackage{<name>}
//   <name>.cls                   \documentclass{<name>} with an empty body
//   tikzlibrary<name>.code.tex   \usepackage{tikz}\usetikzlibrary{<name>}, or
//                                \usepackage{pgfplots}\usetikzlibrary{<name>} for a
//                                library of pgfplots (most need pgfplots first;
//                                \usepgfplotslibrary{X} reads tikzlibrarypgfplots.X)
//
// A run counts only if it ends without an error and reads the entry file
// itself (not a file of the same name in another package). The most frequent
// set of a package becomes its `loads` (on a tie, the set of its main file);
// an entry file with a different set gets its own record. A package with no
// entry files gets an empty `loads`.
// A package whose entry files all fail gets no record: it stays "not
// measured", and the library uses `depends` for it.
//
// Writes:
//   <out>/loads.json   {name: {loads: [...], files: {path: [...]}}}; files has
//                      only the entry files whose set differs from loads
//   <out>/stats.json   counts, and each run that did not count, with the reason
//
//   node measure_loads.cjs <site> <scope> <packages.json> <out>
// <site> has busytex/, the index files and their generated files, and
// texlive/texmf-dist (the tree of the scope). <scope> is the index files of
// the scope below <site>, the lowest layer first, separated by commas (for
// example index/index-full.json). <packages.json> is a JSON list of package
// names, or archives.json of archives/ (the hosted packages).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (!process.env.TEX_JS) throw new Error('set TEX_JS to core.cjs of `nix build .#library`');
const { createEngine, buildScopeTable } = require(process.env.TEX_JS);

// TeX's exit() prints this through Emscripten on every run. It is expected.
const originalConsoleError = console.error;
console.error = (...messageParts) => {
  if (!String(messageParts[0]).includes('keepRuntimeAlive')) originalConsoleError(...messageParts);
};

function loadSite(site, scopePaths) {
  const indexes = scopePaths.map((indexPath) => JSON.parse(fs.readFileSync(path.join(site, indexPath))));
  const lastPath = scopePaths[scopePaths.length - 1];
  return { indexes, scope: buildScopeTable(indexes, lastPath.slice(0, lastPath.lastIndexOf('/') + 1) + 'generated/') };
}

// The document that loads an entry file, or null if the file is no entry file.
function documentFor(packageName, relativePath) {
  if (!relativePath.startsWith('tex/')) return null;
  const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const body = '\\begin{document}x\\end{document}\n';
  let match;
  if ((match = /^tikzlibrary(.+)\.code\.tex$/.exec(fileName))) {
    const base = packageName === 'pgfplots' ? 'pgfplots' : 'tikz';
    return `\\documentclass{article}\\usepackage{${base}}\\usetikzlibrary{${match[1]}}${body}`;
  }
  if ((match = /^(.+)\.sty$/.exec(fileName))) return `\\documentclass{article}\\usepackage{${match[1]}}${body}`;
  if ((match = /^(.+)\.cls$/.exec(fileName))) return `\\documentclass{${match[1]}}\\begin{document}\\end{document}\n`;
  return null;
}

// The most frequent set of a package's runs. On a tie, the set of its main
// file (<name>.sty, then <name>.cls), else the smaller set, else the first.
function packageSet(name, runs, setOf) {
  const counts = new Map();
  for (const run of runs) {
    const key = JSON.stringify(setOf(run));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const mainKeys = [`${name}.sty`, `${name}.cls`]
    .map((fileName) => runs.find((run) => run.relativePath.endsWith('/' + fileName)))
    .filter(Boolean).map((run) => JSON.stringify(setOf(run)));
  const rank = (key) => { const position = mainKeys.indexOf(key); return position === -1 ? mainKeys.length : position; };
  const [bestKey] = [...counts].sort(([keyA, countA], [keyB, countB]) =>
    countB - countA || rank(keyA) - rank(keyB) || JSON.parse(keyA).length - JSON.parse(keyB).length || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0))[0];
  return JSON.parse(bestKey);
}

// A worker: compile each job with a fresh engine, so that each run's list
// holds every file that it reads.
async function runWorker() {
  const { site, scopePaths, jobs } = workerData;
  const { scope } = loadSite(site, scopePaths);
  const busytex = require(path.join(site, 'busytex', 'busytex.js'));
  const wasmModule = new WebAssembly.Module(fs.readFileSync(path.join(site, 'busytex', 'busytex.wasm')));
  const newEngine = () => createEngine({
    busytex, scope, baseUrl: site + '/', wasmModule,
    installedPackages: scope.packages.keys(),
    locateFile: (fileName) => path.join(site, 'busytex', fileName),
    fetchSync: (filePath) => new Uint8Array(fs.readFileSync(filePath)),
  });
  const builder = await newEngine();
  const baseBuild = builder.buildFormat();
  if (baseBuild.exitCode !== 0 || !baseBuild.fmt) throw new Error(`pdflatex.fmt failed (exit ${baseBuild.exitCode}, ${baseBuild.crashed})\n${(baseBuild.log || baseBuild.stdout + baseBuild.stderr).slice(-2000)}`);
  const distRoot = scope.indexes[0].trees['texmf-dist'];
  for (const job of jobs) {
    const engine = await newEngine();
    engine.loadFormat(baseBuild.fmt, 'pdflatex');
    const result = engine.compile(job.source);
    let failure = null;
    if (result.crashed) failure = `crashed: ${result.crashed}`;
    else if (result.exitCode !== 0) {
      const errorLine = (result.log || '').split('\n').find((line) => line.startsWith('! '));
      failure = `exit ${result.exitCode}: ${errorLine || 'no error line'}`;
    } else if (!result.filesLoaded.some(([filePath]) => filePath === `${distRoot}/${job.relativePath}`)) {
      failure = 'the run did not read this file (another file has its name)';
    }
    parentPort.postMessage({ ...job, failure, packagesRead: result.packagesRead, runMs: result.runMs });
  }
}

async function main() {
  const [site, scopeArgument, packagesPath, outputDirectory] = process.argv.slice(2);
  const scopePaths = scopeArgument.split(',');
  const { indexes } = loadSite(site, scopePaths);
  const packages = Object.assign({}, ...indexes.map((index) => index.packages));
  const listed = JSON.parse(fs.readFileSync(packagesPath));
  const names = (Array.isArray(listed) ? listed : Object.keys(listed.hosted)).slice().sort();

  const jobs = [];
  for (const name of names) {
    if (!packages[name]) throw new Error(`package ${name} is not in the index`);
    for (const relativePath of Object.keys(packages[name].files)) {
      const source = documentFor(name, relativePath);
      if (source) jobs.push({ name, relativePath, source });
    }
  }

  const startTime = performance.now();
  const workerCount = Math.max(1, Math.min(jobs.length, Number(process.env.NIX_BUILD_CORES) || os.availableParallelism()));
  const results = [];
  await Promise.all(Array.from({ length: workerCount }, (_, workerNumber) => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { site, scopePaths, jobs: jobs.filter((_, i) => i % workerCount === workerNumber) } });
    worker.on('message', (result) => results.push(result));
    worker.on('error', reject);
    worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`))));
  })));

  const loads = {};
  const unmeasured = [];
  for (const name of names) {
    const runs = results.filter((result) => result.name === name).sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
    const counted = runs.filter((result) => !result.failure);
    if (runs.length && !counted.length) {
      unmeasured.push(name);
      continue;
    }
    const setOf = (result) => result.packagesRead.filter((packageName) => packageName !== name).sort();
    const packageLoads = counted.length ? packageSet(name, counted, setOf) : [];
    const files = {};
    for (const result of counted) {
      const fileLoads = setOf(result);
      if (JSON.stringify(fileLoads) !== JSON.stringify(packageLoads)) files[result.relativePath] = fileLoads;
    }
    loads[name] = { loads: packageLoads, files };
  }

  const failed = results.filter((result) => result.failure).sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  const loadsText = JSON.stringify(loads, null, 1);
  const stats = {
    packages: names.length,
    measured: Object.keys(loads).length,
    withoutEntryFiles: names.filter((name) => !jobs.some((job) => job.name === name)),
    unmeasured,
    runs: results.length,
    counted: results.length - failed.length,
    fileRecords: Object.values(loads).reduce((count, record) => count + Object.keys(record.files).length, 0),
    workers: workerCount,
    wallMs: Math.round(performance.now() - startTime),
    runMsTotal: Math.round(results.reduce((total, result) => total + result.runMs, 0)),
    loadsBytes: Buffer.byteLength(JSON.stringify(loads)),
    failed: failed.map(({ name, relativePath, failure }) => ({ name, file: relativePath, failure })),
  };
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'loads.json'), loadsText);
  fs.writeFileSync(path.join(outputDirectory, 'stats.json'), JSON.stringify(stats, null, 1));
  console.log(`${stats.counted} of ${stats.runs} runs counted, ${stats.measured} of ${stats.packages} packages measured, ${stats.wallMs} ms`);
}

(isMainThread ? main() : runWorker()).catch((error) => {
  console.error(error);
  process.exit(1);
});

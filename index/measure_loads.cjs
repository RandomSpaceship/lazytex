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
//   <out>/stats.json   counts, each run that did not count, with the reason,
//                      and the 20 slowest runs
// and every 10 s a progress line, with each run that takes longer than 20 s.
// A run that takes longer than 90 s is stopped, and counts as failed.
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

// A worker: compile each job that the main thread sends with a fresh engine,
// so that each run's list holds every file that it reads. It asks for its
// first job when pdflatex.fmt is ready, and for the next one with each
// result. null means that no jobs are left.
async function runWorker() {
  const { site, scopePaths } = workerData;
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
  parentPort.on('message', async (job) => {
    if (!job) process.exit(0);
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
  });
  parentPort.postMessage(null);
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
  // The workers take the jobs in order from one queue. The run that each
  // worker is on, or null between runs and after its last.
  let nextJobIndex = 0;
  const workers = new Array(workerCount);
  const currentRuns = new Array(workerCount).fill(null);
  // A compile cannot stop from inside its worker, so the main thread stops
  // the worker of a run that takes too long, counts the run as failed, and
  // starts a new worker for the next jobs. The slowest runs take a few
  // seconds.
  const runTimeLimitMs = 90000;
  const slowRunMs = 20000;
  const stoppedWorkers = new Set();
  const formatSeconds = (milliseconds) => `${Math.floor(milliseconds / 60000)}m${String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0')}s`;
  await new Promise((resolve, reject) => {
    let runningWorkerCount = 0;
    const startWorker = (workerNumber) => {
      runningWorkerCount += 1;
      const worker = new Worker(__filename, { workerData: { site, scopePaths } });
      workers[workerNumber] = worker;
      // A message is a result, or null when the worker is ready for its first job.
      worker.on('message', (result) => {
        if (stoppedWorkers.has(worker)) return;
        if (result) results.push(result);
        const job = nextJobIndex < jobs.length ? jobs[nextJobIndex++] : null;
        currentRuns[workerNumber] = job && { ...job, startedAt: performance.now() };
        worker.postMessage(job);
      });
      worker.on('error', reject);
      worker.on('exit', (code) => {
        runningWorkerCount -= 1;
        if (stoppedWorkers.has(worker)) startWorker(workerNumber);
        else if (code !== 0) reject(new Error(`worker exited with ${code}`));
        if (runningWorkerCount === 0) {
          clearInterval(progressTimer);
          resolve();
        }
      });
    };
    for (let workerNumber = 0; workerNumber < workerCount; workerNumber++) startWorker(workerNumber);
    // Every 10 s: the progress, each slow run, and the stop of each run over the limit.
    const progressTimer = setInterval(() => {
      const now = performance.now();
      const failedCount = results.filter((result) => result.failure).length;
      const busyCount = currentRuns.filter(Boolean).length;
      console.log(`${results.length} of ${jobs.length} runs, ${failedCount} failed, ${busyCount} workers busy, ${formatSeconds(now - startTime)}`);
      currentRuns.forEach((run, workerNumber) => {
        if (!run || now - run.startedAt <= slowRunMs) return;
        const { source, startedAt, ...job } = run;
        if (now - startedAt <= runTimeLimitMs) {
          console.log(`  slow: worker ${workerNumber}, ${job.name}: ${job.relativePath}, ${formatSeconds(now - startedAt)}`);
          return;
        }
        console.log(`  stopped: worker ${workerNumber}, ${job.name}: ${job.relativePath}, over ${runTimeLimitMs / 1000} s`);
        results.push({ ...job, failure: `stopped: no end after ${runTimeLimitMs / 1000} s`, packagesRead: [], runMs: now - startedAt });
        currentRuns[workerNumber] = null;
        stoppedWorkers.add(workers[workerNumber]);
        workers[workerNumber].terminate();
      });
    }, 10000);
  });

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
    slowest: results.slice().sort((a, b) => b.runMs - a.runMs).slice(0, 20)
      .map(({ name, relativePath, runMs, failure }) => ({ name, file: relativePath, runMs: Math.round(runMs), failure })),
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

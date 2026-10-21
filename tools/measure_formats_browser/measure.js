// The cases of tools/measure_formats.cjs (A, B and C) in the browser: the client
// (client.js) with the real worker. tests/run_browser_test.py serves the
// site at /, the library at /js/ and this page at /test/, and writes the
// report:
//   nix build .#example-site -o .scratch/example-site
//   nix build .#library -o .scratch/library
//   mkdir -p .scratch/documents && ln -sf "$PWD"/{tests,example,bundle}/documents/*.tex .scratch/documents/
//   python3 tests/run_browser_test.py --site .scratch/example-site --js .scratch/library \
//     --documents .scratch/documents --page tools/measure_formats_browser \
//     --chromium "$(nix build --no-link --print-out-paths --inputs-from . nixpkgs#chromium)/bin/chromium" \
//     --timeout 900 --report .scratch/format-measurement/browser-formats.json
// The times are wall times in the page, so they include the messages to the
// worker. Each document has a new worker. The server serves the files of
// every package, so an install only tells the client.
import { createTexEngine } from '/js/client.js';

const RUNS = 5;
const DOCUMENTS = ['minimal', 'control-loop', 'note-lecture', 'note-physics', 'note-option-clash', 'motor-circuit', 'fm-plots'];
const FULL = ['index/index-medium.json', 'index/index-full-extra.json'];
const BUNDLES = ['bundle.tar', 'bundle-example.tar'];

const results = [];
const records = [];
const check = (what, pass, detail = null) => {
  results.push({ what, pass: Boolean(pass), detail });
  document.getElementById('output').textContent = results.map((result) => `${result.pass ? 'PASS' : 'FAIL'} ${result.what}`).join('\n');
};
const readDocument = async (fileName) => (await fetch(`/test/documents/${fileName}`)).text();
const newEngine = () => createTexEngine({ baseUrl: new URL('/', location.href).href, createWorker: () => new Worker('/js/worker.js'), scope: FULL, bundles: BUNDLES });
const timed = async (action) => {
  const start = performance.now();
  const result = await action();
  return { result, milliseconds: performance.now() - start };
};

// Compile, and tell the client about the packages that a result needs.
async function compileInRounds(engine, source, options) {
  for (let round = 0; round < 12; round++) {
    const result = await engine.compile(source, options);
    if (result.status !== 'needs') return result;
    await engine.packagesInstalled(result.packages.map(({ name }) => name));
  }
  throw new Error('too many rounds');
}

async function measureDocument(name) {
  const source = await readDocument(`${name}.tex`);
  const engine = newEngine();
  await engine.start();
  const prepared = await compileInRounds(engine, source);
  check(`${name}: compiles`, prepared.status === 'ok', prepared.status);
  for (let run = 0; run < RUNS; run++) {
    const compiled = await timed(() => engine.compile(source));
    records.push({ document: name, case: 'A', run, milliseconds: compiled.milliseconds, runMs: compiled.result.runMs, ok: compiled.result.status === 'ok' });
    const formatName = `document-${run}`;
    const built = await timed(() => engine.buildFormat(formatName, source, { mylatexformat: true }));
    if (built.result.status !== 'ok') {
      records.push({ document: name, case: 'B', run, ok: false });
      continue;
    }
    const first = await timed(() => engine.compile(source, { format: formatName }));
    records.push({ document: name, case: 'B', run, buildMilliseconds: built.milliseconds, compileMilliseconds: first.milliseconds,
      milliseconds: built.milliseconds + first.milliseconds, fmtBytes: built.result.fmt.length, ok: first.result.status === 'ok' });
    const later = await timed(() => engine.compile(source, { format: formatName }));
    records.push({ document: name, case: 'C', run, milliseconds: later.milliseconds, ok: later.result.status === 'ok' });
  }
  engine.stop();
}

async function run() {
  for (const name of DOCUMENTS) await measureDocument(name);
  return { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, runs: RUNS, records };
}

run()
  .then((timings) => ({ timings }), (error) => {
    check('no exception', false, String(error && error.stack || error));
    return {};
  })
  .then((extra) => fetch('/report', { method: 'POST', body: JSON.stringify({ results, ...extra }) }));

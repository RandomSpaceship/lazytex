// Browser test of the client (client.js) with the real worker (worker.js).
// run_browser_test.py serves the site at /, the library at /js/ and this
// page at /test/. The page posts its results to /report.
//
// The server serves the example app's site (both releases) and the files of
// every package (the full tree), so an "install" here only tells the client.
// The Node tests check real installs.
import { createTexEngine } from '/js/client.js';

const results = [];
const check = (what, pass, detail = null) => {
  results.push({ what, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${what}`);
  document.getElementById('output').textContent = results.map((result) => `${result.pass ? 'PASS' : 'FAIL'} ${result.what}`).join('\n');
};
const isPdf = (bytes) => bytes && new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-';
// A result for the report: byte arrays as their lengths, and the end of the log.
const brief = (result) => ({
  ...result,
  ...('pdf' in result ? { pdf: result.pdf ? result.pdf.length : null } : {}),
  ...('fmt' in result ? { fmt: result.fmt ? result.fmt.length : null } : {}),
  log: result.log ? result.log.slice(-400) : null,
});

// On lines of their own: a format skips the preamble line by line.
const MINIMAL = '\\documentclass{standalone}\n\\usepackage{tikz}\n\\begin{document}\n\\tikz\\draw (0,0) -- (1,1);\\end{document}\n';
const TIKZ_CD = '\\documentclass{standalone}\\usepackage{tikz-cd}\\begin{document}\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}\\end{document}\n';
const LOOP = '\\documentclass{article}\\begin{document}\\loop\\iftrue\\repeat\\end{document}\n';
const MEDIUM = ['index/index-medium.json'];
// lazytex's bundle, then the example app's.
const BUNDLES = ['bundle.tar', 'bundle-example.tar'];
const FULL = ['index/index-medium.json', 'index/index-full-extra.json'];
const sameScope = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stagesOf = (reports) => [...new Set(reports.map(({ stage }) => stage))];
const BROKEN = '\\documentclass{standalone}\n\\usepackage{tikz}\n\\begin{document}\n\\thiscommanddoesnotexist\n\\end{document}\n';

// Compile, and tell the client about the packages that a result needs.
async function compileInRounds(engine, source, options) {
  const rounds = [];
  for (let round = 0; round < 12; round++) {
    const result = await engine.compile(source, options);
    if (result.status !== 'needs') return { result, rounds };
    rounds.push(result.packages.map(({ name }) => name));
    await engine.packagesInstalled(rounds[rounds.length - 1]);
  }
  throw new Error('too many rounds: ' + JSON.stringify(rounds));
}

window.addEventListener('error', (event) => console.log(`page error: ${event.message}`));
window.addEventListener('unhandledrejection', (event) => console.log(`unhandled rejection: ${event.reason}`));

async function run() {
  console.log('test page started');
  const chessboard = await (await fetch('/test/documents/chessboard.tex')).text();
  const progress = [];
  const engine = createTexEngine({
    baseUrl: new URL('/', location.href).href,
    createWorker: () => new Worker('/js/worker.js'),
    scope: MEDIUM,
    bundles: BUNDLES,
    onProgress: (report) => progress.push(report),
  });

  const started = await engine.start();
  const stages = new Set(progress.map(({ stage }) => stage));
  check('start: reports progress for the engine, the index and the bundle', ['engine', 'index', 'bundle', 'files'].every((stage) => stages.has(stage)), [...stages]);
  const bundleReports = progress.filter(({ stage }) => stage === 'bundle');
  const lastBundle = bundleReports[bundleReports.length - 1];
  check('start: the bundle progress ends at its total', lastBundle && lastBundle.total && lastBundle.loaded === lastBundle.total, lastBundle);
  check('start: the scope that the app gave', sameScope(started.scope, MEDIUM) && sameScope(engine.scope, MEDIUM), started);
  check('start: both bundles are downloaded', bundleReports.filter(({ total }) => total).length === BUNDLES.length, bundleReports);

  const minimal = await engine.compile(MINIMAL);
  check('compile: a bundle document gives a PDF', minimal.status === 'ok' && isPdf(minimal.pdf), brief(minimal));
  check('compile: packagesRead names the packages that it read', minimal.packagesRead && ['pgf', 'standalone'].every((name) => minimal.packagesRead.includes(name)), minimal.packagesRead);

  const scanned = await engine.scan(TIKZ_CD);
  check('scan: tikz-cd is not installed, and the preamble names its file', scanned.status === 'needs'
    && JSON.stringify(scanned.packages) === JSON.stringify([{ name: 'tikz-cd', reason: 'scan', files: ['tikz-cd.sty'] }]), scanned);
  check('scan: operations lists the loads of the preamble', JSON.stringify(scanned.operations) === JSON.stringify([
    { kind: 'class', names: ['standalone'], options: [] }, { kind: 'package', names: ['tikz-cd'], options: [] }]), scanned.operations);
  check('scan: a bundle document needs nothing', (await engine.scan(MINIMAL)).status === 'ok');
  const needs = await engine.compile(TIKZ_CD);
  check('needs: a compile scans first, and the engine does not run', needs.status === 'needs' && needs.packages[0].reason === 'scan'
    && needs.log === null && needs.runMs === 0, brief(needs));
  const logNeeds = await engine.compile(TIKZ_CD, { scan: false });
  check('needs: without the scan, the log names the file', logNeeds.status === 'needs'
    && JSON.stringify(logNeeds.packages) === JSON.stringify([{ name: 'tikz-cd', reason: 'log', files: ['tikz-cd.sty'] }]), brief(logNeeds));
  const { result: tikzCd } = await compileInRounds(engine, TIKZ_CD);
  check('needs: after the install, it compiles', tikzCd.status === 'ok' && isPdf(tikzCd.pdf), brief(tikzCd));

  const broken = await engine.compile(BROKEN);
  check('error: message and line', broken.status === 'error' && /Undefined control sequence/.test(broken.errors[0].message) && broken.errors[0].line === 4, broken.errors);

  // A format of MINIMAL's own preamble.
  const format = await engine.buildFormat('tikz', MINIMAL, { mylatexformat: true });
  check('format: builds', format.status === 'ok' && format.fmt && format.fmt.length > 1e6, brief(format));
  const withFormat = await engine.compile(MINIMAL, { format: 'tikz' });
  check('format: a compile with it gives a PDF', withFormat.status === 'ok' && isPdf(withFormat.pdf), brief(withFormat));
  const key = await engine.formatKey(MINIMAL, { mylatexformat: true });
  check('format: the cache key is a SHA-512', /^[0-9a-f]{128}$/.test(key), key);
  const lazytexOnly = createTexEngine({ baseUrl: new URL('/', location.href).href, createWorker: () => new Worker('/js/worker.js'), scope: MEDIUM });
  check('format: the key depends on the bundles', (await lazytexOnly.formatKey(MINIMAL, { mylatexformat: true })) !== key);
  const [commentOne, commentTwo] = await Promise.all(['% one\r\n', '% two  \n'].map((comment) => engine.formatKey(comment + MINIMAL, { mylatexformat: true })));
  check('format: a change to the comments keeps the key', commentOne === commentTwo && commentOne !== key, [commentOne, commentTwo]);
  const [verbOne, verbTwo] = await Promise.all(['\\verb|50%|abc', '\\verb|50%|xyz'].map((source) => engine.formatKey(source)));
  check('format: a change to protected text gives a new key', verbOne !== verbTwo, verbOne);

  const timedOut = await engine.compile(LOOP, { timeoutMs: 3000 });
  check('timeout: an endless loop stops after the limit', timedOut.status === 'timeout', timedOut);
  const afterTimeout = await engine.compile(MINIMAL, { format: 'tikz' });
  check('timeout: the next compile starts a new worker, with the format loaded again', afterTimeout.status === 'ok' && isPdf(afterTimeout.pdf), brief(afterTimeout));
  const tikzCdAgain = await engine.compile(TIKZ_CD);
  check('timeout: the new worker has the installed packages', tikzCdAgain.status === 'ok', brief(tikzCdAgain));

  progress.length = 0;
  const scopeNeed = await engine.compile(chessboard);
  check('needs: chessboard has a file that no loaded index has', scopeNeed.status === 'needs' && scopeNeed.packages.length === 0
    && sameScope(scopeNeed.files, ['chessboard.sty']), brief(scopeNeed));
  check('needs: the compile loaded no other index', progress.length === 0, stagesOf(progress));
  const found = await engine.findScope(scopeNeed.files, [MEDIUM, FULL]);
  check('findScope: the full scope has chessboard.sty', sameScope(found.scope, FULL) && found.files.length === 0, found);
  check('findScope: it loaded the extra index, with progress', sameScope(stagesOf(progress), ['index']), stagesOf(progress));
  const notFound = await engine.findScope(['no-such-package.sty'], [MEDIUM, FULL]);
  check('findScope: no scope has a wrong name', notFound.scope === null && sameScope(notFound.files, ['no-such-package.sty']), notFound);
  progress.length = 0;
  const switched = await engine.setScope(FULL);
  check('setScope: the same worker changes to the full scope', switched && sameScope(switched.scope, FULL) && sameScope(engine.scope, FULL), switched);
  check('setScope: no download and no index parse again (only the file nodes)', sameScope(stagesOf(progress), ['files']), stagesOf(progress));
  const formatAfterScope = await engine.compile(MINIMAL, { format: 'tikz' });
  check('setScope: the new engine has the format', formatAfterScope.status === 'ok' && isPdf(formatAfterScope.pdf), brief(formatAfterScope));
  const { result: chess, rounds } = await compileInRounds(engine, chessboard);
  check('full scope: chessboard compiles after its installs', chess.status === 'ok' && isPdf(chess.pdf), { rounds, result: brief(chess) });
  check('full scope: packagesRead names chessboard', chess.packagesRead && chess.packagesRead.includes('chessboard'), chess.packagesRead);

  const timings = { start: started.timings, setScope: switched && switched.timings, minimalRunMs: minimal.runMs, formatRunMs: format.runMs };
  engine.stop();

  // A scope change right after start(), without a wait: the start and the
  // scope change must not stop each other's worker.
  const second = createTexEngine({ baseUrl: new URL('/', location.href).href, createWorker: () => new Worker('/js/worker.js'), scope: MEDIUM, bundles: BUNDLES });
  const [secondStart, secondScope] = await Promise.all([second.start(), second.setScope(FULL)]);
  const secondCompile = await second.compile(MINIMAL);
  check('queue: start() and then setScope() at once give the full scope, and a compile works',
    sameScope(secondStart.scope, MEDIUM) && secondScope && sameScope(secondScope.scope, FULL) && secondCompile.status === 'ok',
    { secondStart: secondStart.scope, secondScope: secondScope && secondScope.scope, compile: brief(secondCompile) });
  let threw = false;
  try { createTexEngine({ baseUrl: '/', createWorker: () => null, scope: [] }); } catch { threw = true; }
  check('options: an empty scope is an error', threw);
  second.stop();
  return timings;
}

run()
  .then((timings) => ({ timings }), (error) => {
    check('no exception', false, String(error && error.stack || error));
    return {};
  })
  .then((extra) => fetch('/report', { method: 'POST', body: JSON.stringify({ results, ...extra }) }));

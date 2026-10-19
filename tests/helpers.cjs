// Shared setup for the Node tests: the site of the example app (example/:
// both releases, and the full tree as a stand-in for installed packages),
// engines from the library in a scope, compiles in rounds with package
// installs, and output checks.
//
// Environment (all necessary): TEX_SITE (nix build .#example-site), TEX_JS
// (core.cjs of nix build .#library), TEX_DOCUMENTS (the test documents, the
// example's documents and lazytex's bundle documents in one directory) and
// BUNDLE_DOCUMENTS (example/bundle-documents.json).
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPackageSource } = require('./package-source.cjs');

const SITE = process.env.TEX_SITE;
if (!SITE) throw new Error('set TEX_SITE to the output of `nix build .#example-site`');
if (!process.env.TEX_JS) throw new Error('set TEX_JS to core.cjs of `nix build .#library`');
for (const name of ['TEX_DOCUMENTS', 'BUNDLE_DOCUMENTS']) if (!process.env[name]) throw new Error(`set ${name}`);
const DOCUMENTS = process.env.TEX_DOCUMENTS;
const library = require(process.env.TEX_JS);
const busytex = require(path.join(SITE, 'busytex', 'busytex.js'));
const mediumIndex = JSON.parse(fs.readFileSync(path.join(SITE, 'index', 'index-medium.json')));
const extraIndex = JSON.parse(fs.readFileSync(path.join(SITE, 'index', 'index-full-extra.json')));
const releaseManifest = JSON.parse(fs.readFileSync(path.join(SITE, 'manifest.json')));
const indexesOf = (scope) => (scope === 'medium' ? [mediumIndex] : [mediumIndex, extraIndex]);
const bundleDefinition = JSON.parse(fs.readFileSync(process.env.BUNDLE_DOCUMENTS));
// The documents of lazytex's own bundle (bundle/bundle-documents.json).
const LAZYTEX_BUNDLE_DOCUMENTS = ['article', 'standalone'];
// The bundles of the site, lazytex's first: bundle.tar, then the app's.
const BUNDLE_FILES = ['bundle.tar', ...fs.readdirSync(SITE).filter((name) => /^bundle-.+\.tar$/.test(name)).sort()];
const scopeTables = { medium: library.buildScopeTable(indexesOf('medium')), full: library.buildScopeTable(indexesOf('full')) };
// The candidate scopes of the example app, smallest first, for findScopeIn().
const candidateScopes = [{ scope: 'medium', indexes: indexesOf('medium') }, { scope: 'full', indexes: indexesOf('full') }];
const findScope = (fileNames) => library.findScopeIn(fileNames, candidateScopes, undefined, library.alternativeFileNames);

// TeX's exit() prints this through Emscripten on every run. It is expected.
const originalConsoleError = console.error;
console.error = (...messageParts) => {
  if (!String(messageParts[0]).includes('keepRuntimeAlive')) originalConsoleError(...messageParts);
};

const readBundles = () => BUNDLE_FILES.map((name) => library.readTarBundle(new Uint8Array(fs.readFileSync(path.join(SITE, name)))));
// The analysis context of each engine, as the worker has it: the bundles'
// packages and file names (empty without the bundles).
const bundleOfEngine = new WeakMap();

// An engine in one scope, with no installed packages. With withBundle, the
// bundles are preloaded (lazytex's has pdflatex.fmt and texmf.cnf); without
// them, pdflatex.fmt is copied from lazytex's bundle, and kpathsea
// (texmf.cnf) is installed, because TeX cannot load a format without
// texmf.cnf. Returns the engine and its package source.
async function newEngine({ scope = 'medium', withBundle = true, installed = [] } = {}) {
  const scopeTable = scopeTables[scope];
  const packageSource = createPackageSource({ site: SITE, scope: scopeTable });
  packageSource.install(withBundle ? installed : ['kpathsea', ...installed]);
  const bundles = readBundles();
  const engine = await library.createEngine({
    busytex,
    scope: scopeTable,
    baseUrl: SITE + '/',
    locateFile: (fileName) => path.join(SITE, 'busytex', fileName),
    fetchSync: packageSource.fetchSync,
    installedPackages: packageSource.installed(),
    bundles: withBundle ? bundles : [],
  });
  bundleOfEngine.set(engine, withBundle
    ? { bundlePackages: library.bundlePackagesOf(bundles, scopeTable), bundleFileNames: library.bundleFileNamesOf(bundles) }
    : { bundlePackages: new Set(), bundleFileNames: new Set() });
  if (!withBundle) {
    const [, offset, size] = bundles[0].manifest.find(([filePath]) => filePath.endsWith('/pdflatex.fmt'));
    engine.loadFormat(bundles[0].bytes.slice(offset, offset + size), 'pdflatex');
  }
  return { engine, packageSource };
}

const analysisContextOf = (engine, packageSource) => ({
  isInstalled: (name) => packageSource.installed().includes(name),
  ...bundleOfEngine.get(engine),
});

// What a compile result means (analyzeCompile), as the client gives it.
function outcomeOf(engine, packageSource, result) {
  return library.analyzeCompile(
    { succeeded: result.exitCode === 0 && result.pdf !== null, log: result.log, terminal: result.stdout, filesFailed: result.filesFailed },
    engine.scope,
    analysisContextOf(engine, packageSource),
  );
}

// The scan of a source (analyzeScan), as the worker does it before a run.
function scanOutcomeOf(engine, packageSource, source) {
  return library.analyzeScan(library.scanPreamble(source), engine.scope, analysisContextOf(engine, packageSource));
}

// Compile, and install the packages that a result needs, until the compile
// succeeds or needs something else. With scan (as the client does it by
// default), each round scans first and compiles only if the scan finds
// nothing. Returns the last result and outcome, the packages of each round,
// and the number of compiles.
function compileInRounds(engine, packageSource, source, { maxRounds = 10, scan = true } = {}) {
  const rounds = [];
  let compiles = 0;
  for (let round = 0; round < maxRounds; round++) {
    const scanned = scan ? scanOutcomeOf(engine, packageSource, source) : { status: 'ok' };
    let result = null;
    let outcome = scanned;
    if (scanned.status !== 'needs') {
      result = engine.compile(source);
      compiles++;
      outcome = outcomeOf(engine, packageSource, result);
    }
    if (outcome.status !== 'needs' || !outcome.packages.length) return { result, outcome, rounds, compiles };
    const names = outcome.packages.map(({ name }) => name);
    rounds.push(names);
    packageSource.install(names);
    engine.installPackages(names);
  }
  throw new Error(`still needs packages after ${maxRounds} rounds: ${JSON.stringify(rounds)}`);
}

const readDocument = (name) => fs.readFileSync(path.join(DOCUMENTS, name + '.tex'), 'utf8');

const tail = (text) => (text || '').slice(-1500);
function assertCompiled(result, what) {
  assert.equal(result.crashed, null, `${what}: engine crashed: ${result.crashed}`);
  assert.equal(result.exitCode, 0, `${what}: exit ${result.exitCode}\n${tail(result.log)}`);
  assert.ok(result.pdf && Buffer.from(result.pdf.subarray(0, 5)).toString() === '%PDF-', `${what}: no PDF`);
}

// Render page 1 of a PDF with pdftoppm (150 dpi, PPM).
function renderFirstPage(pdfBytes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  try {
    fs.writeFileSync(path.join(directory, 'page.pdf'), pdfBytes);
    const result = childProcess.spawnSync('pdftoppm', ['-r', '150', '-singlefile', 'page.pdf', 'page'], { cwd: directory });
    if (result.status !== 0) throw new Error('pdftoppm failed: ' + String(result.stderr) + String(result.error || ''));
    return fs.readFileSync(path.join(directory, 'page.ppm'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = {
  SITE, library, mediumIndex, extraIndex, findScope, releaseManifest, indexesOf, scopeTables, bundleDefinition,
  LAZYTEX_BUNDLE_DOCUMENTS, BUNDLE_FILES, newEngine, outcomeOf, scanOutcomeOf, compileInRounds, readBundles, readDocument,
  assertCompiled, renderFirstPage,
};

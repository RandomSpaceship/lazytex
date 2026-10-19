// Tests of the library with the releases (lazytex's and the example app's):
// the scopes, the bundles in layers, package installs between compiles, the
// `needs` result, and the switch from the medium scope to the full scope.
// check_release.py checks the formats and hashes of the releases.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SITE, library, mediumIndex, findScope, scopeTables, bundleDefinition, LAZYTEX_BUNDLE_DOCUMENTS, BUNDLE_FILES, newEngine, outcomeOf,
  compileInRounds, readBundles, readDocument, assertCompiled, renderFirstPage,
} = require('./helpers.cjs');

const DIST_MOUNT = mediumIndex.trees['texmf-dist'] + '/';
const noUnexpectedRequests = (packageSource) => assert.deepEqual(packageSource.unexpectedRequests, [], 'no request for a file of a package that is not installed');

test('scopes: the medium scope is a subset of the full scope', () => {
  const { medium, full } = scopeTables;
  assert.ok(medium.fileCount > 20000 && full.fileCount > medium.fileCount * 4, `${medium.fileCount} medium, ${full.fileCount} full`);
  for (const name of medium.packages.keys()) assert.ok(full.packages.has(name), name);
  assert.equal(medium.fileAt(DIST_MOUNT + 'tex/latex/pgf/basiclayer/pgf.sty').packageName, 'pgf');
  assert.equal(medium.fileAt('/texlive/texmf-var/fonts/map/pdftex/updmap/pdftex.map').urlPath, 'index/generated/medium/texmf-var/fonts/map/pdftex/updmap/pdftex.map');
  assert.equal(full.fileAt('/texlive/texmf-var/fonts/map/pdftex/updmap/pdftex.map').urlPath, 'index/generated/full-extra/texmf-var/fonts/map/pdftex/updmap/pdftex.map');
});

test('scopes: a file name in tex/latex and in tex/latex-dev belongs first to the package that pdfLaTeX reads', () => {
  assert.deepEqual(scopeTables.medium.packagesWithFileName('multicol.sty'), ['tools', 'latex-tools-dev']);
  assert.deepEqual(scopeTables.medium.packagesWithFileName('article.cls'), ['latex', 'latex-base-dev']);
});

test('scopes: the dependency closure follows depends', () => {
  const closure = library.dependencyClosure(['pgfplots'], scopeTables.medium.packages);
  for (const name of ['pgfplots', 'pgf', 'xcolor', 'graphics']) assert.ok(closure.includes(name), `${name} in ${closure}`);
});

test('bundle: the tar reader finds every file, as views into the tar', () => {
  assert.deepEqual(BUNDLE_FILES, ['bundle.tar', 'bundle-example.tar']);
  for (const name of BUNDLE_FILES) {
    const tarBytes = new Uint8Array(fs.readFileSync(path.join(SITE, name)));
    const bundle = library.readTarBundle(tarBytes);
    assert.equal(bundle.bytes, tarBytes);
    assert.ok(bundle.manifest.length > 50, `${name}: ${bundle.manifest.length} files`);
    // pdflatex.fmt is only in lazytex's bundle.
    assert.equal(bundle.manifest.some(([filePath]) => filePath === '/home/web_user/fmt/pdflatex.fmt'), name === 'bundle.tar', name);
    for (const [filePath, offset, size] of bundle.manifest) {
      assert.ok(filePath.startsWith('/') && offset % 512 === 0 && offset + size <= tarBytes.length, filePath);
    }
  }
});

test('bundle: the layers have no file in common, and two bundles with one file are an error', async () => {
  const [lazytexBundle, appBundle] = readBundles();
  const lazytexPaths = new Set(lazytexBundle.manifest.map(([filePath]) => filePath));
  assert.deepEqual(appBundle.manifest.filter(([filePath]) => lazytexPaths.has(filePath)), []);
  const scope = scopeTables.medium;
  await assert.rejects(library.createEngine({
    busytex: require(path.join(SITE, 'busytex', 'busytex.js')), scope, baseUrl: SITE + '/',
    locateFile: (fileName) => path.join(SITE, 'busytex', fileName), fetchSync: () => new Uint8Array(),
    installedPackages: [], bundles: [lazytexBundle, lazytexBundle],
  }), /two bundles have/);
});

for (const documentName of [...LAZYTEX_BUNDLE_DOCUMENTS, ...bundleDefinition.documents]) {
  test(`bundle: ${documentName} compiles with no installed packages, and loads only generated files`, async () => {
    const { engine, packageSource } = await newEngine();
    const result = engine.compile(readDocument(documentName));
    assertCompiled(result, documentName);
    assert.equal(outcomeOf(engine, packageSource, result).status, 'ok');
    assert.deepEqual(packageSource.installs, [], 'no package installs');
    for (const [filePath] of result.filesLoaded) assert.ok(!filePath.startsWith(DIST_MOUNT) || filePath.endsWith('/ls-R'), filePath);
    assert.ok(engine.files.materializedDirectories() < 200, `${engine.files.materializedDirectories()} directories made`);
  });
}

test('installs: without the bundle, motor-circuit and fm-plots install their packages in rounds, and give the same pages', async () => {
  const { engine, packageSource } = await newEngine({ withBundle: false });
  const { engine: bundleEngine, packageSource: bundleSource } = await newEngine();
  for (const documentName of ['motor-circuit', 'fm-plots']) {
    // TeX stops at the first missing file, so most rounds install one package.
    const { result, outcome, rounds } = compileInRounds(engine, packageSource, readDocument(documentName), { maxRounds: 30 });
    assert.equal(outcome.status, 'ok', `${documentName}: ${JSON.stringify(outcome)}`);
    console.log(`${documentName} without the bundle: ${rounds.length} rounds`);
    assertCompiled(result, documentName);
    assert.ok(rounds.length >= 1, `${documentName}: ${rounds.length} rounds`);
    const { result: reference } = compileInRounds(bundleEngine, bundleSource, readDocument(documentName), { maxRounds: 30 });
    assertCompiled(reference, `${documentName} with the bundles`);
    assert.ok(renderFirstPage(result.pdf).equals(renderFirstPage(reference.pdf)), `${documentName}: rendered page differs`);
  }
  const fromRelease = packageSource.installs.filter((install) => install.source === 'release').map((install) => install.name);
  for (const name of ['pgf', 'pgfplots', 'circuitikz', 'siunitx']) assert.ok(fromRelease.includes(name), `${name} from its archive`);
  noUnexpectedRequests(packageSource);
  packageSource.remove();
});

test('needs: a compile result gives the package of the missing file first, and why each other package is there', async () => {
  const { engine, packageSource } = await newEngine({ withBundle: false });
  const outcome = outcomeOf(engine, packageSource, engine.compile('\\documentclass{article}\\usepackage{pgfplots}\\begin{document}x\\end{document}'));
  assert.equal(outcome.status, 'needs');
  // article.cls is in the latex package. TeX stops at the first missing file.
  assert.deepEqual(outcome.packages[0], { name: 'latex', reason: 'log', files: ['article.cls'] });
  for (const packageNeed of outcome.packages.slice(1)) {
    assert.ok(['loads', 'depends'].includes(packageNeed.reason) && packageNeed.requiredBy, JSON.stringify(packageNeed));
  }
  // No download data: the app reads it from the index.
  for (const packageNeed of outcome.packages) assert.deepEqual(Object.keys(packageNeed).filter((key) => !['name', 'reason', 'files', 'requiredBy'].includes(key)), []);
  assert.deepEqual(outcome.files, []);
  assert.ok(outcome.errors.some(({ message }) => message.includes('article.cls')), JSON.stringify(outcome.errors));
  noUnexpectedRequests(packageSource);
});

test('needs: the closure uses the file record, then the package record, then depends, and leaves out the bundle packages', () => {
  const bundlePackages = library.bundlePackagesOf(readBundles(), scopeTables.medium);
  const analyze = (fileName, withBundle) => library.analyzeCompile(
    { succeeded: false, log: `! LaTeX Error: File \`${fileName}' not found.\n` }, scopeTables.medium,
    { isInstalled: () => false, bundlePackages: withBundle ? bundlePackages : new Set() });
  const byName = (outcome) => Object.fromEntries(outcome.packages.map((packageNeed) => [packageNeed.name, packageNeed]));
  // The package record of pgfplots: all its packages are in the bundle.
  assert.deepEqual(analyze('pgfplots.sty', true).packages, [{ name: 'pgfplots', reason: 'log', files: ['pgfplots.sty'] }]);
  const pgfplots = byName(analyze('pgfplots.sty', false));
  assert.deepEqual(pgfplots.pgf, { name: 'pgf', reason: 'loads', requiredBy: 'pgfplots' });
  assert.equal(pgfplots.hyperref, undefined);
  // bugtracker.sty has its own record, with hyperref.
  assert.deepEqual(byName(analyze('bugtracker.sty', true)).hyperref, { name: 'hyperref', reason: 'loads', requiredBy: 'pgfplots' });
  // glossaries is not measured (no release hosts it): its depends closure,
  // and the record of each measured package in it (amsmath), which the
  // closure does not go through.
  assert.equal(scopeTables.medium.packages.get('glossaries').loads, undefined);
  const glossaries = byName(analyze('glossaries.sty', false));
  assert.deepEqual(glossaries.datatool, { name: 'datatool', reason: 'depends', requiredBy: 'glossaries' });
  assert.deepEqual(glossaries.substr, { name: 'substr', reason: 'depends', requiredBy: 'datatool' });
  assert.deepEqual(glossaries.amsmath, { name: 'amsmath', reason: 'depends', requiredBy: 'glossaries' });
  for (const name of scopeTables.medium.packages.get('amsmath').loads) assert.ok(glossaries[name], `${name} from the record of amsmath`);
  const withBundle = byName(analyze('glossaries.sty', true));
  assert.ok(withBundle.datatool && !withBundle.amsmath && !withBundle.xkeyval, Object.keys(withBundle).join(' '));
  // A package that the log names is always there, also a bundle package.
  assert.deepEqual(analyze('multicol.sty', true).packages[0], { name: 'tools', reason: 'log', files: ['multicol.sty'] });
});

test('mirror packages: chessboard needs a file that only the full scope has, then installs from the mirrors', async () => {
  const { engine: mediumEngine, packageSource: mediumSource } = await newEngine();
  const outcome = outcomeOf(mediumEngine, mediumSource, mediumEngine.compile(readDocument('chessboard')));
  assert.equal(outcome.status, 'needs');
  assert.deepEqual([outcome.packages, outcome.files], [[], ['chessboard.sty']]);
  assert.ok(outcome.errors.some(({ message }) => message.includes('chessboard.sty')), JSON.stringify(outcome.errors));
  assert.deepEqual(findScope(outcome.files), { scope: 'full', files: [] });

  const { engine, packageSource } = await newEngine({ scope: 'full' });
  const { result, outcome: finalOutcome, rounds } = compileInRounds(engine, packageSource, readDocument('chessboard'));
  assert.equal(finalOutcome.status, 'ok', JSON.stringify(finalOutcome));
  assertCompiled(result, 'chessboard');
  // Mirror packages come from the mirrors; a bundle's package (latex for
  // ifthen.sty) from its release archive in lazytex's release.
  const sourceOf = Object.fromEntries(packageSource.installs.map((install) => [install.name, install.source]));
  for (const name of ['chessboard', 'chessfss', 'skaknew']) assert.equal(sourceOf[name], 'mirror', name);
  assert.equal(sourceOf.latex, 'release');
  assert.match(engine.scope.packages.get('latex').releaseArchive.url, /^https:\/\/github\.com\/RandomSpaceship\/lazytex\//);
  // TeX Live lists no dependencies for chessboard, and some files of the
  // bundle's packages are not in the bundle, so each round adds one package.
  assert.ok(rounds.length >= 2 && rounds.length <= 10, `${rounds.length} rounds: ${JSON.stringify(rounds)}`);
  console.log(`chessboard in the full scope: ${rounds.length} rounds: ${JSON.stringify(rounds)}`);
  const mirrorPackageNames = result.packagesRead.filter((name) => !engine.scope.packages.get(name).releaseArchive);
  for (const name of ['chessboard', 'chessfss', 'skaknew']) assert.ok(mirrorPackageNames.includes(name), `${name} in the mirror-package report ${mirrorPackageNames}`);
  // The SkakNew Type 1 font is embedded: the full scope's pdftex.map has it.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-'));
  fs.writeFileSync(path.join(directory, 'chessboard.pdf'), result.pdf);
  const fonts = childProcess.execFileSync('pdffonts', [path.join(directory, 'chessboard.pdf')], { encoding: 'utf8' });
  assert.match(fonts, /\+SkakNew-Diagram\s+Type 1\s+Builtin\s+yes/, fonts);
  fs.rmSync(directory, { recursive: true, force: true });
  noUnexpectedRequests(packageSource);
  packageSource.remove();
});

test('mirror packages: a TikZ library outside the medium scope is in the full scope, then compiles', async () => {
  const { engine: mediumEngine, packageSource: mediumSource } = await newEngine();
  const outcome = outcomeOf(mediumEngine, mediumSource, mediumEngine.compile(readDocument('tikz-library-mirror')));
  assert.deepEqual([outcome.status, outcome.packages, outcome.files], ['needs', [], ['tikzlibrarywargame.hex.code.tex']]);
  assert.deepEqual(findScope(outcome.files), { scope: 'full', files: [] });
  const { engine, packageSource } = await newEngine({ scope: 'full' });
  const { result, rounds } = compileInRounds(engine, packageSource, readDocument('tikz-library-mirror'));
  assertCompiled(result, 'tikz-library-mirror');
  assert.ok(rounds.some((names) => names.includes('wargame')), JSON.stringify(rounds));
});

test('analysis: wrapped logs, pgfplots libraries, and files that no scope has', () => {
  const analyze = (log) => library.analyzeCompile({ succeeded: false, log }, scopeTables.medium, { isInstalled: () => false });
  // A TikZ error as TeX writes it: broken after every 79 characters.
  const message = "! Package tikz Error: I did not find the tikz library 'wargame.chit'. I looked "
    + 'for files named tikzlibrarywargame.chit.code.tex and pgflibrarywargame.chit.code.tex.';
  const wrapped = message.match(/.{1,79}/g).join('\n') + '\n';
  assert.equal(wrapped.split('\n')[0].length, 79);
  const chit = analyze(wrapped);
  assert.deepEqual([chit.status, chit.files], ['needs', ['tikzlibrarywargame.chit.code.tex']]);
  assert.deepEqual(findScope(chit.files), { scope: 'full', files: [] });
  // pgfplots inputs pgflibrarypgfplots.<name>.code.tex last; no scope has this one.
  const noLibrary = analyze("! I can't find file `pgflibrarypgfplots.nosuchlibrary.code.tex'.\n");
  assert.deepEqual(findScope(noLibrary.files), { scope: null, files: ['pgflibrarypgfplots.nosuchlibrary.code.tex'] });
  // No scope has it: the app shows the errors.
  const unfixable = analyze("! LaTeX Error: File `no-such-package.sty' not found.\n");
  assert.deepEqual([unfixable.status, unfixable.packages, unfixable.files], ['needs', [], ['no-such-package.sty']]);
  assert.match(unfixable.errors[0].message, /no-such-package\.sty/);
  assert.deepEqual(findScope(['chessboard.sty', 'no-such-package.sty']), { scope: null, files: ['no-such-package.sty'] });
  // Another form of the name: a pgfplots library can also be a TikZ library file.
  assert.deepEqual(findScope(['pgflibrarypgfplots.groupplots.code.tex']), { scope: 'medium', files: [] });
  // An error with no missing file.
  assert.equal(analyze('! Undefined control sequence.\nl.4 \\foo\n').status, 'error');
  // A medium package that is not installed.
  const needs = analyze("! LaTeX Error: File `pgfplots.sty' not found.\n");
  assert.equal(needs.status, 'needs');
  assert.ok(needs.packages.some(({ name }) => name === 'pgfplots') && needs.packages.some(({ name }) => name === 'pgf'));
  assert.equal(library.unwrapTexLog('a'.repeat(79) + '\nb\nc'), 'a'.repeat(79) + 'b\nc');
});

test('analysis: a TeX error gives its message and the line of the document', async () => {
  const { engine, packageSource } = await newEngine();
  const outcome = outcomeOf(engine, packageSource, engine.compile(readDocument('broken')));
  assert.equal(outcome.status, 'error');
  assert.match(outcome.errors[0].message, /Undefined control sequence/);
  const brokenLine = readDocument('broken').split('\n').findIndex((line) => line.includes('\\thiscommanddoesnotexist')) + 1;
  assert.equal(outcome.errors[0].line, brokenLine, JSON.stringify(outcome.errors[0]));
});

// The text of page 1, as a reader copies it (pdftotext).
function copiedText(pdfBytes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'text-'));
  try {
    fs.writeFileSync(path.join(directory, 'page.pdf'), pdfBytes);
    return childProcess.execFileSync('pdftotext', [path.join(directory, 'page.pdf'), '-'], { encoding: 'utf8' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('copied text: pdflatex.fmt maps glyphs to Unicode, and glyphtounicode-cmex adds the large math symbols', async () => {
  const { engine, packageSource } = await newEngine();
  const document = readDocument('copied-text');
  const plain = engine.compile(document);
  assertCompiled(plain, 'copied-text');
  const plainText = copiedText(plain.pdf);
  // LaTeX reads glyphtounicode.tex into the format, so these need nothing.
  for (const expected of ['office', 'efficient', 'fluff', '\u2014', '\u201Cquotes\u201D', '\u03B1', '\u03B2', '\u2264', '\u2192', '\u221E']) {
    assert.ok(plainText.includes(expected), `copied text has ${expected}: ${plainText}`);
  }
  assert.ok(!plainText.includes('\u2211'), 'without glyphtounicode-cmex, the large sum is not a sum sign');
  const { result: withCmex } = compileInRounds(engine, packageSource,
    document.replace('\\begin{document}', '\\input{glyphtounicode-cmex}\n\\begin{document}'));
  assertCompiled(withCmex, 'copied-text with glyphtounicode-cmex');
  const cmexText = copiedText(withCmex.pdf);
  // Each size of a large symbol has its own variation selector (U+FE01 to U+FE04).
  for (const expected of ['\u2211', '(', ')', '\u222B']) {
    assert.ok(cmexText.includes(expected), `copied text with glyphtounicode-cmex has ${expected}: ${cmexText}`);
  }
  assert.ok(renderFirstPage(withCmex.pdf).equals(renderFirstPage(plain.pdf)), 'glyphtounicode-cmex does not change the page');
  noUnexpectedRequests(packageSource);
});

test('engine: repeated compiles give the same PDF, and the heap does not grow', async () => {
  const { engine } = await newEngine();
  const first = engine.compile(readDocument('control-loop'));
  assertCompiled(first, 'control-loop');
  const heapAfterFirst = engine.heapBytes();
  for (let run = 0; run < 3; run++) {
    const again = engine.compile(readDocument('control-loop'));
    assert.deepEqual(again.pdf, first.pdf, `run ${run + 2}: same PDF`);
  }
  assert.equal(engine.heapBytes(), heapAfterFirst);
});

test('engine: a TeX error leaves the engine usable, and a warm compile makes no requests', async () => {
  const { engine } = await newEngine();
  const first = engine.compile(readDocument('minimal'));
  assertCompiled(first, 'minimal');
  const broken = engine.compile(readDocument('broken'));
  assert.equal(broken.crashed, null);
  assert.notEqual(broken.exitCode, 0);
  const again = engine.compile(readDocument('minimal'));
  assertCompiled(again, 'minimal after an error');
  assert.deepEqual(again.pdf, first.pdf);
  assert.deepEqual(again.filesLoaded, [], 'a warm compile requested files again');
});

test('engine: a file that does not load gives an error, not an ok with an empty file', async () => {
  // TeX takes a failed read as the end of the file, so without the check the
  // compile succeeds without the package.
  const { engine, packageSource } = await newEngine({ scope: 'full' });
  const source = '\\documentclass{article}\\usepackage{CharisSIL}\\begin{document}x\\end{document}';
  engine.installPackages(['charissil']); // the engine has it, the package cache does not
  const result = engine.compile(source);
  assert.deepEqual(result.filesFailed.map(([filePath]) => filePath), [DIST_MOUNT + 'tex/latex/charissil/CharisSIL.sty']);
  const outcome = outcomeOf(engine, packageSource, result);
  assert.equal(outcome.status, 'error');
  assert.match(outcome.errors[0].message, /^could not read .*CharisSIL\.sty: /);
  // The file loads on a later run, when the package cache has it.
  packageSource.install(['charissil']);
  const { result: fixed, outcome: fixedOutcome } = compileInRounds(engine, packageSource, source);
  assert.equal(fixedOutcome.status, 'ok');
  assert.deepEqual(fixed.filesFailed, []);
});

// Tests for the scan of the preamble (scanPreamble(), analyzeScan()), and
// for the two paths that find packages: the scan before a run, and the log
// after it. The client scans by default; compileInRounds() does the same
// (scan: false gives the log path only).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  library, scopeTables, bundleDefinition, LAZYTEX_BUNDLE_DOCUMENTS, readBundles, newEngine, outcomeOf, scanOutcomeOf, compileInRounds,
  readDocument, assertCompiled, renderFirstPage,
} = require('./helpers.cjs');

const { scanPreamble } = library;
const DOCUMENT = (preamble, body = 'x') => `${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`;
const namesOf = (outcome) => (outcome.packages ?? []).map(({ name }) => name);

test('scan: the loads of a preamble, with options and lists', () => {
  const source = DOCUMENT([
    '\\documentclass[tikz, border=2pt]{standalone}',
    '\\usepackage[RPvoltages,european]{circuitikz}',
    '\\usepackage{amsmath, amssymb,',
    '  mathtools}[2020/01/01]',
    '\\usepackage[key={a,b}]{xcolor}',
    '\\RequirePackage{etoolbox}',
    '\\usetikzlibrary{positioning, shapes.geometric}',
    '\\usetikzlibrary[calc]',
    '\\usepgflibrary{arrows.meta}',
    '\\usepgfplotslibrary{groupplots,fillbetween}',
    '\\input{glyphtounicode-cmex}',
    '\\input mymacros.tex',
  ].join('\n'));
  assert.deepEqual(scanPreamble(source), [
    { kind: 'class', names: ['standalone'], options: ['tikz', 'border=2pt'] },
    { kind: 'package', names: ['circuitikz'], options: ['RPvoltages', 'european'] },
    { kind: 'package', names: ['amsmath', 'amssymb', 'mathtools'], options: [] },
    { kind: 'package', names: ['xcolor'], options: ['key={a,b}'] },
    { kind: 'package', names: ['etoolbox'], options: [] },
    { kind: 'tikzlibrary', names: ['positioning', 'shapes.geometric'], options: [] },
    { kind: 'tikzlibrary', names: ['calc'], options: [] },
    { kind: 'pgflibrary', names: ['arrows.meta'], options: [] },
    { kind: 'pgfplotslibrary', names: ['groupplots', 'fillbetween'], options: [] },
    { kind: 'input', names: ['glyphtounicode-cmex'], options: [] },
    { kind: 'input', names: ['mymacros.tex'], options: [] },
  ]);
});

test('scan: comments, the body, macros, and sources without a preamble end', () => {
  // Comments go, also in the middle of a list. \% is not a comment.
  assert.deepEqual(scanPreamble(DOCUMENT('% \\usepackage{one}\n\\usepackage{two,% three\n four}\\def\\x{50\\%}\\usepackage{five}')).map(({ names }) => names),
    [['two', 'four'], ['five']]);
  // Only the preamble: loads in the body are for the log.
  assert.deepEqual(scanPreamble(DOCUMENT('\\documentclass{article}', '\\usetikzlibrary{calc}\\input{body}')), [{ kind: 'class', names: ['article'], options: [] }]);
  // Names with macros or groups are left out.
  assert.deepEqual(scanPreamble(DOCUMENT('\\usepackage{\\mypackages, tikz}\\usetikzlibrary{#1}\\input{\\jobname}')), [{ kind: 'package', names: ['tikz'], options: [] }]);
  // Longer command names are other commands.
  assert.deepEqual(scanPreamble(DOCUMENT('\\usepackagex{a}\\inputencoding{b}\\usepackage@{c}')), []);
  // No \begin{document}: the scan reads nothing, and the compile reports it.
  assert.deepEqual(scanPreamble('\\documentclass{article}\\usepackage{tikz}'), []);
  // A format source ends at \dump.
  assert.deepEqual(scanPreamble('\\usepackage{tikz}\\dump\\usepackage{after}'), [{ kind: 'package', names: ['tikz'], options: [] }]);
  // CRLF and a space before \begin{document}'s brace.
  assert.deepEqual(scanPreamble('\\usepackage{a}\r\n\\begin {document}\\usepackage{b}'), [{ kind: 'package', names: ['a'], options: [] }]);
});

test('scan: the outcome leaves out installed packages and bundle files, and gives the files that no loaded index has', () => {
  const bundles = readBundles();
  const context = {
    isInstalled: (name) => name === 'tikz-cd',
    bundlePackages: library.bundlePackagesOf(bundles, scopeTables.medium),
    bundleFileNames: library.bundleFileNamesOf(bundles),
  };
  const analyze = (preamble) => library.analyzeScan(scanPreamble(DOCUMENT(preamble)), scopeTables.medium, context);
  // The bundles have these files: nothing to install.
  assert.deepEqual(analyze('\\documentclass{standalone}\\usepackage{tikz,amsmath}\\usetikzlibrary{calc}'), { status: 'ok' });
  // pgfplots is not in a bundle: the scan asks for it, and its closure
  // leaves out the bundle packages (pgf, xcolor, graphics).
  const pgfplots = analyze('\\usepackage{pgfplots}');
  assert.deepEqual(pgfplots.packages[0], { name: 'pgfplots', reason: 'scan', files: ['pgfplots.sty'] });
  for (const { name } of pgfplots.packages) assert.ok(!context.bundlePackages.has(name) || name === 'pgfplots', name);
  // Installed.
  assert.deepEqual(analyze('\\usepackage{tikz-cd}'), { status: 'ok' });
  // A file of a bundle package that is not in the bundle: the scan asks for
  // the package, but its closure leaves out the bundle packages.
  const decorations = analyze('\\usetikzlibrary{decorations.fractals}');
  if (!context.bundleFileNames.has('tikzlibrarydecorations.fractals.code.tex')) {
    assert.deepEqual(decorations.packages, [{ name: 'pgf', reason: 'scan', files: ['tikzlibrarydecorations.fractals.code.tex'] }]);
  }
  // Not installed, with its closure. The scan has no errors.
  const glossaries = analyze('\\usepackage{glossaries}');
  assert.equal(glossaries.status, 'needs');
  assert.deepEqual(glossaries.packages[0], { name: 'glossaries', reason: 'scan', files: ['glossaries.sty'] });
  assert.ok(glossaries.packages.some(({ name, reason }) => name === 'datatool' && reason === 'depends'), JSON.stringify(glossaries));
  assert.deepEqual([glossaries.files, glossaries.errors], [[], []]);
  // Outside the medium scope, and in no scope.
  const outside = analyze('\\usepackage{chessboard}\\usetikzlibrary{wargame.hex}\\usepackage{no-such-package}');
  assert.deepEqual([outside.packages, outside.files], [[], ['chessboard.sty', 'tikzlibrarywargame.hex.code.tex', 'no-such-package.sty']]);
});

test('scan: the bundle documents need nothing (no download that the compile does not need)', async () => {
  const { engine, packageSource } = await newEngine();
  // The file-name table costs 7 to 60 ms to make. The scan of a bundle
  // document must not make it.
  const lookups = [];
  const packagesWithFileName = engine.scope.packagesWithFileName;
  engine.scope.packagesWithFileName = (name) => {
    lookups.push(name);
    return packagesWithFileName(name);
  };
  for (const name of [...LAZYTEX_BUNDLE_DOCUMENTS, ...bundleDefinition.documents, 'copied-text', 'broken']) {
    assert.deepEqual(scanOutcomeOf(engine, packageSource, readDocument(name)), { status: 'ok' }, name);
  }
  engine.scope.packagesWithFileName = packagesWithFileName;
  assert.deepEqual(lookups, []);
});

test('scan and log: without the bundle, both paths give the same pages, and the scan saves compiles', async () => {
  for (const documentName of ['motor-circuit', 'fm-plots']) {
    const runs = {};
    for (const scan of [false, true]) {
      const { engine, packageSource } = await newEngine({ withBundle: false });
      const run = compileInRounds(engine, packageSource, readDocument(documentName), { maxRounds: 30, scan });
      assert.equal(run.outcome.status, 'ok', `${documentName} (scan ${scan}): ${JSON.stringify(run.outcome)}`);
      assertCompiled(run.result, `${documentName} (scan ${scan})`);
      runs[scan] = { ...run, page: renderFirstPage(run.result.pdf), installed: packageSource.installed() };
      packageSource.remove();
    }
    const [logOnly, scanned] = [runs[false], runs[true]];
    console.log(`${documentName} without the bundle: log only ${logOnly.rounds.length} rounds and ${logOnly.compiles} compiles; `
      + `with the scan ${scanned.rounds.length} rounds and ${scanned.compiles} compiles`);
    assert.ok(scanned.page.equals(logOnly.page), `${documentName}: rendered page differs`);
    assert.ok(scanned.compiles < logOnly.compiles, `${documentName}: ${scanned.compiles} compiles with the scan, ${logOnly.compiles} without`);
    // The packages that the scan found itself are packages that the compile reads.
    const { engine, packageSource } = await newEngine({ withBundle: false });
    const firstScan = scanOutcomeOf(engine, packageSource, readDocument(documentName));
    for (const { name, reason } of firstScan.packages) {
      if (reason === 'scan') assert.ok(scanned.result.packagesRead.includes(name), `${documentName}: the scan asked for ${name}, which the compile does not read`);
    }
    packageSource.remove();
  }
});

test('scan and log: a load in the body is for the log', async () => {
  const { engine, packageSource } = await newEngine();
  const source = DOCUMENT('\\documentclass{standalone}\\usepackage{tikz}', '\\usetikzlibrary{wargame.hex}\\tikz\\draw (0,0) -- (1,0);');
  assert.deepEqual(scanOutcomeOf(engine, packageSource, source), { status: 'ok' });
  const outcome = outcomeOf(engine, packageSource, engine.compile(source));
  assert.deepEqual([outcome.status, outcome.files], ['needs', ['tikzlibrarywargame.hex.code.tex']]);
  packageSource.remove();
});

// Tests for formats that the engine builds on top of pdflatex.fmt (from
// lazytex's bundle), with the library and the releases. An app builds a
// format of a document's own preamble (mylatexformat) on the device, and
// compiles the document without changes.
//
// A format must give the same page as a compile without it. The PDF bytes can
// differ, so the tests compare rendered pixels (pdftoppm). The bundle has the
// files of these builds (the bundle trace builds them), so no test installs a
// package.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { bundleDefinition, newEngine, readDocument, assertCompiled, renderFirstPage } = require('./helpers.cjs');

const DOCUMENTS = bundleDefinition.documents;

let engine;
const referencePages = {};

function buildFormatOrFail(options) {
  const result = engine.buildFormat(options);
  assert.equal(result.crashed, null, `${options.formatName}: engine crashed: ${result.crashed}`);
  assert.equal(result.exitCode, 0, `${options.formatName}: format build failed\n${(result.log || '').slice(-1500)}`);
  assert.ok(result.fmt && result.fmt.length > 1e6, `${options.formatName}: no format`);
  return result;
}

function compilePage(texSource, formatName, what) {
  const result = engine.compile(texSource, { formatName });
  assertCompiled(result, what);
  return renderFirstPage(result.pdf);
}

before(async () => {
  ({ engine } = await newEngine());
  for (const name of DOCUMENTS) {
    referencePages[name] = compilePage(readDocument(name), 'pdflatex', `${name} (reference)`);
  }
});

for (const name of DOCUMENTS) {
  test(`formats: ${name} gives the same page with a format of its own preamble`, () => {
    buildFormatOrFail({ formatName: 'document', source: readDocument(name), mylatexformat: true });
    assert.ok(compilePage(readDocument(name), 'document', name).equals(referencePages[name]), 'rendered page differs');
  });
}

// A format skips the preamble of the document line by line, up to
// \begin{document}. So a document with \documentclass and \begin{document}
// on one line fails.
test('formats: a document with its preamble on one line fails with its format', () => {
  const oneLine = '\\documentclass{standalone}\\usepackage{tikz}\\begin{document}\\tikz\\draw (0,0) -- (1,1);\\end{document}\n';
  buildFormatOrFail({ formatName: 'one-line', source: oneLine, mylatexformat: true });
  const result = engine.compile(oneLine, { formatName: 'one-line' });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.log, /Two \\documentclass/);
});

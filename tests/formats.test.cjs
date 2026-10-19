// Tests for TikZ formats that the engine builds on top of pdflatex.fmt (from
// lazytex's bundle), with the library and the releases. An app builds these
// formats on the device.
//
// Three kinds of format:
//   package   TikZ and libraries, loaded before the class. Documents compile
//             without changes.
//   preamble  A full preamble, made with mylatexformat. Documents use the
//             preamble form (toPreambleForm()).
//   document  The preamble of one document, made with mylatexformat. That
//             document compiles without changes.
//
// A format must give the same page as a compile without it. The PDF bytes can
// differ, so the tests compare rendered pixels (pdftoppm). The bundle has the
// files of these builds (the bundle trace builds both forms of the shared
// format), so no test installs a package.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { library, bundleDefinition, newEngine, readDocument, assertCompiled, renderFirstPage } = require('./helpers.cjs');

const formatContents = JSON.parse(fs.readFileSync(path.join(process.env.TEX_DOCUMENTS, 'format-contents.json')));
// Pages that load no TikZ libraries or extra packages (see example/documents/).
const PROBE_PAGES = ['minimal', 'probe-tikz', 'probe-math'];
// The other documents of the example's bundle: real diagrams.
const DIAGRAMS = bundleDefinition.documents.filter((name) => !PROBE_PAGES.includes(name));

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
  buildFormatOrFail({ formatName: 'tikz-package', source: library.formatSource(formatContents, 'package') });
  buildFormatOrFail({ formatName: 'tikz-preamble', source: library.formatSource(formatContents, 'preamble'), mylatexformat: true });
  for (const name of [...PROBE_PAGES, ...DIAGRAMS]) {
    referencePages[name] = compilePage(readDocument(name), 'pdflatex', `${name} (reference)`);
  }
});

for (const name of DIAGRAMS) {
  test(`formats: ${name} gives the same page with the package format`, () => {
    assert.ok(compilePage(readDocument(name), 'tikz-package', name).equals(referencePages[name]), 'rendered page differs');
  });

  test(`formats: ${name} gives the same page with the preamble format (preamble form)`, () => {
    const page = compilePage(library.toPreambleForm(readDocument(name)), 'tikz-preamble', name);
    assert.ok(page.equals(referencePages[name]), 'rendered page differs');
  });

  test(`formats: ${name} gives the same page with a format of its own preamble`, () => {
    buildFormatOrFail({ formatName: 'document', source: readDocument(name), mylatexformat: true });
    assert.ok(compilePage(readDocument(name), 'document', name).equals(referencePages[name]), 'rendered page differs');
  });
}

// The shared format must not change documents that do not load its libraries
// and packages. format-contents.json leaves out arrows.meta and bending for
// this reason: they change the default arrow tips.
for (const name of PROBE_PAGES) {
  test(`formats: the shared format does not change ${name}, which loads none of its contents`, () => {
    assert.ok(compilePage(readDocument(name), 'tikz-package', name).equals(referencePages[name]), 'rendered page differs');
  });
}

// Without \endofdump, a preamble format skips the document's preamble up to
// \begin{document}. Definitions in that preamble are then lost.
test('formats: the preamble format skips the preamble of a full document', () => {
  const result = engine.compile(readDocument('control-loop'), { formatName: 'tikz-preamble' });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.log, /Undefined control sequence[\s\S]*\\hborder/);
});

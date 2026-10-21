// Measure the cost of formats in Node: a compile without a format, against a
// format of the document's own preamble. quartz-resources'
// docs/findings/format-cost-measurement.md has the results of 2026-10-22,
// which also had shared formats (cases D and E; lazytex removed them).
//
// For each document, in a new engine (scope full, so that the full tree
// stands in for installed packages):
//   A  compile with pdflatex.fmt
//   B  buildFormat of the document's preamble (mylatexformat), then the
//      first compile with that format
//   C  a later compile with the format of B
// Before the timed runs, the script compiles each document in rounds, so
// that each package that it needs is installed and no run downloads.
//
// Usage (from the repo root):
//   nix build .#example-site -o .scratch/example-site
//   nix build .#library -o .scratch/library
//   mkdir -p .scratch/documents && ln -sf "$PWD"/{tests,example,bundle}/documents/*.tex .scratch/documents/
//   TEX_SITE=$PWD/.scratch/example-site TEX_JS=$PWD/.scratch/library/core.cjs TEX_DOCUMENTS=.scratch/documents \
//     BUNDLE_DOCUMENTS=example/bundle-documents.json node tools/measure_formats.cjs \
//     --runs 5 --out .scratch/formats.json minimal control-loop note-lecture …
//
// It prints the median of each case, and writes each run to --out (JSON).
// Needs pdftoppm on PATH (tests/helpers.cjs).
const fs = require('node:fs');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { newEngine, readDocument, compileInRounds } = require('../tests/helpers.cjs');

const argumentList = process.argv.slice(2);
const optionValue = (name, fallback) => {
  const position = argumentList.indexOf(name);
  return position === -1 ? fallback : argumentList.splice(position, 2)[1];
};
const runs = Number(optionValue('--runs', '5'));
const outPath = optionValue('--out', null);
const documentNames = argumentList;
if (!documentNames.length) throw new Error('give the names of the documents to measure');

const records = [];
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const timed = (action) => {
  const start = performance.now();
  const result = action();
  return { result, milliseconds: performance.now() - start };
};
const succeeded = (result) => result.crashed === null && result.exitCode === 0;

function record(document, measuredCase, fields) {
  records.push({ document, case: measuredCase, ...fields });
}

function buildOrNull(engine, formatName, source) {
  const { result, milliseconds } = timed(() => engine.buildFormat({ formatName, source, mylatexformat: true }));
  return succeeded(result) && result.fmt ? { milliseconds, bytes: result.fmt.length } : null;
}

async function measureDocument(name) {
  const source = readDocument(name);
  const { engine, packageSource } = await newEngine({ scope: 'full' });
  const prepared = compileInRounds(engine, packageSource, source);
  if (prepared.outcome.status !== 'ok') throw new Error(`${name}: ${JSON.stringify(prepared.outcome)}`);

  for (let run = 0; run < runs; run++) {
    const compiled = timed(() => engine.compile(source));
    record(name, 'A', { run, milliseconds: compiled.milliseconds, ok: succeeded(compiled.result) });

    const formatName = `document-${run}`;
    const built = buildOrNull(engine, formatName, source);
    if (!built) {
      record(name, 'B', { run, ok: false });
      continue;
    }
    const first = timed(() => engine.compile(source, { formatName }));
    record(name, 'B', { run, buildMilliseconds: built.milliseconds, compileMilliseconds: first.milliseconds,
      milliseconds: built.milliseconds + first.milliseconds, fmtBytes: built.bytes, ok: succeeded(first.result) });
    const later = timed(() => engine.compile(source, { formatName }));
    record(name, 'C', { run, milliseconds: later.milliseconds, ok: succeeded(later.result) });
  }
}

(async () => {
  for (const name of documentNames) await measureDocument(name);

  const conditions = { date: new Date().toISOString(), node: process.version, cpu: os.cpus()[0].model, platform: `${os.platform()} ${os.release()}`, runs };
  console.log(JSON.stringify(conditions));
  for (const name of documentNames) {
    for (const measuredCase of ['A', 'B', 'C']) {
      const caseRecords = records.filter((entry) => entry.document === name && entry.case === measuredCase);
      if (!caseRecords.length) continue;
      const failed = caseRecords.filter((entry) => !entry.ok).length;
      const passed = caseRecords.filter((entry) => entry.ok);
      const parts = passed.length ? [`${Math.round(median(passed.map((entry) => entry.milliseconds)))} ms`] : [];
      if (measuredCase === 'B' && passed.length) {
        parts.push(`(build ${Math.round(median(passed.map((entry) => entry.buildMilliseconds)))} ms, compile ${Math.round(median(passed.map((entry) => entry.compileMilliseconds)))} ms)`);
      }
      if (passed.length && passed[0].fmtBytes) parts.push(`fmt ${Math.round(median(passed.map((entry) => entry.fmtBytes)) / 1024)} KB`);
      if (failed) parts.push(`${failed} of ${caseRecords.length} failed`);
      console.log(`${name.padEnd(20)} ${measuredCase}  ${parts.join(' ')}`);
    }
  }
  if (outPath) fs.writeFileSync(outPath, JSON.stringify({ conditions, records }, null, 2));
})();

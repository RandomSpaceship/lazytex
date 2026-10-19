// Find the files of a preloaded bundle: run the engine in Node, in a scope
// with all its packages visible, on the documents and format builds of a
// bundle definition (bundle-documents.json), and on each document with each
// of those formats, and record every file that each run reads. Writes:
//   <out>/fmt/pdflatex.fmt   the LaTeX format, made by this engine
//   <out>/files-read.json    {run name: [path, ...]}, for each run
//                            (<document>@<format> for a document with a format)
//
// Each run uses a fresh engine, so its list holds every file that it reads,
// also files that an earlier run read.
//
//   node trace_bundle.cjs <site> <scope> <bundle-documents.json> <documents> <out>
// <site> has busytex/, the index files with their generated files, and
// texlive/texmf-dist (the tree of the scope). <scope> is the index files of
// the scope below <site>, the lowest layer first, separated by commas.
// <documents> has the documents and the format contents files that the
// definition names.
const fs = require('node:fs');
const path = require('node:path');

const [site, scopeArgument, definitionPath, documentsDirectory, outputDirectory] = process.argv.slice(2);
// The wrapper library: core.cjs of nix build .#library (TEX_JS).
if (!process.env.TEX_JS) throw new Error('set TEX_JS to core.cjs of `nix build .#library`');
const { createEngine, buildScopeTable, formatSource, toPreambleForm } = require(process.env.TEX_JS);
const busytex = require(path.join(site, 'busytex', 'busytex.js'));
const scopePaths = scopeArgument.split(',');
const lastPath = scopePaths[scopePaths.length - 1];
const scope = buildScopeTable(scopePaths.map((indexPath) => JSON.parse(fs.readFileSync(path.join(site, indexPath)))),
  lastPath.slice(0, lastPath.lastIndexOf('/') + 1) + 'generated/');
const definition = JSON.parse(fs.readFileSync(definitionPath));

// TeX's exit() prints this through Emscripten on every run. It is expected.
const originalConsoleError = console.error;
console.error = (...messageParts) => {
  if (!String(messageParts[0]).includes('keepRuntimeAlive')) originalConsoleError(...messageParts);
};

// All packages of the scope are visible: the trace finds the files that the
// documents read.
const newEngine = () => createEngine({
  busytex, scope, baseUrl: site + '/',
  installedPackages: scope.packages.keys(),
  locateFile: (fileName) => path.join(site, 'busytex', fileName),
  fetchSync: (filePath) => new Uint8Array(fs.readFileSync(filePath)),
});

function check(result, what) {
  if (result.exitCode !== 0 || result.crashed) {
    throw new Error(`${what} failed (exit ${result.exitCode}, ${result.crashed})\n${(result.log || '').slice(-2000)}`);
  }
}

const pathsOf = (result) => result.filesLoaded.map(([filePath]) => filePath).sort();

(async () => {
  fs.mkdirSync(path.join(outputDirectory, 'fmt'), { recursive: true });
  const filesRead = {};

  const builder = await newEngine();
  const baseBuild = builder.buildFormat();
  check(baseBuild, 'pdflatex.fmt');
  filesRead['format:pdflatex'] = pathsOf(baseBuild);
  fs.writeFileSync(path.join(outputDirectory, 'fmt', 'pdflatex.fmt'), baseBuild.fmt);

  const readDocument = (documentName) => fs.readFileSync(path.join(documentsDirectory, documentName + '.tex'), 'utf8');
  const formatBytes = {};
  for (const format of definition.formats ?? []) {
    const engine = await newEngine();
    engine.loadFormat(baseBuild.fmt, 'pdflatex');
    const contents = JSON.parse(fs.readFileSync(path.join(documentsDirectory, format.contents)));
    const result = engine.buildFormat({
      formatName: format.name,
      source: formatSource(contents, format.kind),
      mylatexformat: format.kind === 'preamble',
    });
    check(result, `${format.name}.fmt`);
    filesRead[`format:${format.name}`] = pathsOf(result);
    formatBytes[format.name] = result.fmt;
  }

  for (const documentName of definition.documents) {
    const engine = await newEngine();
    engine.loadFormat(baseBuild.fmt, 'pdflatex');
    const result = engine.compile(readDocument(documentName));
    check(result, documentName);
    filesRead[documentName] = pathsOf(result);
  }

  // The documents with each format: a document can read other files then.
  // For example, with amsmath in the format before the class, a 12pt class
  // reads cmex10.tfm at more sizes.
  for (const format of definition.formats ?? []) {
    for (const documentName of definition.documents) {
      const engine = await newEngine();
      engine.loadFormat(baseBuild.fmt, 'pdflatex');
      engine.loadFormat(formatBytes[format.name], format.name);
      const source = format.kind === 'preamble' ? toPreambleForm(readDocument(documentName)) : readDocument(documentName);
      const result = engine.compile(source, { formatName: format.name });
      check(result, `${documentName} with ${format.name}.fmt`);
      filesRead[`${documentName}@${format.name}`] = pathsOf(result);
    }
  }
  fs.writeFileSync(path.join(outputDirectory, 'files-read.json'), JSON.stringify(filesRead, null, 1));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

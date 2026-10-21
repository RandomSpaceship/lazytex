// Find the files of a preloaded bundle: run the engine in Node, in a scope
// with all its packages visible, on the documents of a bundle definition
// (bundle-documents.json), and record every file that each run reads. Each
// document also gets a format of its own preamble (mylatexformat), and
// compiles with it, so that an app can build such formats on the device
// without package installs. Writes:
//   <out>/fmt/pdflatex.fmt   the LaTeX format, made by this engine
//   <out>/files-read.json    {run name: [path, ...]}, for each run
//                            (format:<document> for the format build, and
//                            <document>@format for the compile with it)
//
// Each run uses a fresh engine, so its list holds every file that it reads,
// also files that an earlier run read.
//
//   node trace_bundle.cjs <site> <scope> <bundle-documents.json> <documents> <out>
// <site> has busytex/, the index files with their generated files, and
// texlive/texmf-dist (the tree of the scope). <scope> is the index files of
// the scope below <site>, the lowest layer first, separated by commas.
// <documents> has the documents that the definition names.
const fs = require('node:fs');
const path = require('node:path');

const [site, scopeArgument, definitionPath, documentsDirectory, outputDirectory] = process.argv.slice(2);
// The wrapper library: core.cjs of nix build .#library (TEX_JS).
if (!process.env.TEX_JS) throw new Error('set TEX_JS to core.cjs of `nix build .#library`');
const { createEngine, buildScopeTable } = require(process.env.TEX_JS);
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
  for (const documentName of definition.documents) {
    const engine = await newEngine();
    engine.loadFormat(baseBuild.fmt, 'pdflatex');
    const result = engine.compile(readDocument(documentName));
    check(result, documentName);
    filesRead[documentName] = pathsOf(result);

    // A format of the document's own preamble, and the document with it: a
    // document can read other files then.
    const formatEngine = await newEngine();
    formatEngine.loadFormat(baseBuild.fmt, 'pdflatex');
    const formatBuild = formatEngine.buildFormat({ formatName: 'document', source: readDocument(documentName), mylatexformat: true });
    check(formatBuild, `${documentName}.fmt`);
    filesRead[`format:${documentName}`] = pathsOf(formatBuild);
    const withFormat = await newEngine();
    withFormat.loadFormat(baseBuild.fmt, 'pdflatex');
    withFormat.loadFormat(formatBuild.fmt, 'document');
    const formatResult = withFormat.compile(readDocument(documentName), { formatName: 'document' });
    check(formatResult, `${documentName} with its format`);
    filesRead[`${documentName}@format`] = pathsOf(formatResult);
  }
  fs.writeFileSync(path.join(outputDirectory, 'files-read.json'), JSON.stringify(filesRead, null, 1));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

# The library

The TypeScript library that an app imports to run the engine. Each lazytex
release has it in `js/` ([`docs/formats.md`](../docs/formats.md)).
[`docs/design.md`](../docs/design.md) explains how a compile works.

| File | What it is |
|---|---|
| `client.js` | The API for apps, as an ES module. It runs on the main thread. |
| `worker.js` | The engine's Web Worker, as a classic script (it loads `busytex.js` with `importScripts`). |
| `types/client.d.ts` | The TypeScript declarations of the API. |
| `core.cjs` | Not in the release. The synchronous engine, the scope table and the log parsing, for Node: the tests and the build tools use it. |

`nix build .#library` checks the types with `tsc` and makes the files with
esbuild.

## Use in an app

```ts
import { createTexEngine } from './vendor/lazytex/js/client.js';

// The app's scopes, smallest first. A scope is a list of index files below
// baseUrl, the lowest layer first.
const MEDIUM = ['index/index-medium.json'];
const FULL = ['index/index-medium.json', 'index/index-full-extra.json'];

const tex = createTexEngine({
  baseUrl: 'http://my-app-tex.localhost/',   // for example a custom scheme; ends with '/'
  createWorker: () => new Worker(new URL('./vendor/lazytex/js/worker.js', import.meta.url)),
  scope: savedScope ?? MEDIUM,                // necessary: the library has no default scope
  bundles: ['bundle.tar', 'bundle-my-app.tar'], // default ['bundle.tar']: lazytex's bundle only
  installedPackages: await listPackageCache(),
  onProgress: ({ stage, loaded, total }) => showStartProgress(stage, loaded, total),
});

await tex.start();   // optional: start early, for example when the user edits a LaTeX block

// Optional: install the packages of a note before its first compile, for
// example when the note opens. A 'needs' result is the same as from compile().
const scanned = await tex.scan(source);
if (scanned.status === 'needs') await installForNote(scanned.packages, scanned.operations);

for (;;) {
  const result = await tex.compile(source, { format: 'pdflatex' });
  if (result.status === 'ok') { await convertAndCache(result.pdf); break; }
  if (result.status === 'needs' && result.packages.length) {
    // Read each package's archive from the index. Warn for packages without
    // releaseArchive (mirror packages). Show progress.
    await downloadVerifyUnpack(result.packages.map((packageNeed) => packageNeed.name));
    await tex.packagesInstalled(result.packages.map((packageNeed) => packageNeed.name));
    continue;
  }
  if (result.status === 'needs' && result.files.length) {
    // Files that no loaded index has: look for a larger scope.
    const found = await tex.findScope(result.files, [MEDIUM, FULL]);
    if (found.scope) {
      // Warn, and save the scope for the device.
      await tex.setScope(found.scope);
      continue;
    }
    // No scope has them: a wrong name, or a package that TeX Live does not have.
  }
  showErrors(result);  // 'error' and 'needs' (with line numbers), 'timeout' or 'crashed'
  break;
}
```

The app makes the worker, because a worker must come from the app's own
origin. The worker loads the engine, the index files and the bundles from
`baseUrl`. [`example/web/app.js`](../example/web/app.js) is a complete page
with this loop (`nix run .#example`).

## What `baseUrl` must serve

The release files at their release paths (lazytex's, and a child release's
if the app has one), and the installed packages:

| Path | Contents |
|---|---|
| `busytex/busytex.js`, `busytex/busytex.wasm` | The engine. Serve `busytex.wasm` with `Content-Type: application/wasm`, so that the worker can compile it during the download. |
| `bundle.tar`, `bundle-<app>.tar` | The bundles of the `bundles` option. |
| `manifest.json` | The manifest (for `formatKey()`): the child release's, if the app has one. |
| `index/index-<layer>.json`, `index/generated/…` | The index files and the generated files. The generated files of a scope are in `generated/<scope>/` next to its last index file, where `<scope>` is that index's `scope` value. |
| `texlive/texmf-dist/<path>` | The files of the installed packages, from the package cache. |

The worker reads TeX files with synchronous `GET` requests (`responseType`
`arraybuffer`). Responses to another origin need
`Access-Control-Allow-Origin`.

## The API

| Method | What it does |
|---|---|
| `start()` | Starts the worker, if it is not running. Reports progress with `onProgress`. |
| `compile(source, { format, timeoutMs, scan })` | Compiles a document. `format` is `'pdflatex'` (default) or a format that `buildFormat()` or `loadFormat()` gave. With `scan` (default `true`), the worker scans the preamble first. If the scan finds needs, the result is that `needs`, and the engine does not run. |
| `scan(source)` | The scan of `compile()`, without a compile: `ok` or `needs`, and `operations` (see "The scan"). |
| `buildFormat(name, source, { mylatexformat, timeoutMs, scan })` | Builds a format on top of `pdflatex.fmt`. With `mylatexformat`, `source` is a document whose preamble goes into the format. Without it, `source` must end with `\dump`. `scan` as for `compile()`. |
| `loadFormat(name, bytes)` | Loads a format from the app's cache. |
| `formatKey(source, { mylatexformat })` | The cache key of a format: a SHA-512 of the engine, the bundles, the index files, the upstream versions and the source after `normalizeSource()`. A new release with a changed package gives a new key. |
| `packagesInstalled(names)` | Tells the engine about new packages in the package cache. |
| `findScope(files, candidates)` | The first of the candidate scopes (smallest first) that has all the files, as `{ scope, files }`: `scope` is `null` if no candidate has them all, and `files` has the files that no candidate has. A name also matches its other forms (for example `pgflibraryX.code.tex` for `tikzlibraryX.code.tex`). The worker loads a candidate's index files only when it gets to it. |
| `setScope(scope)` | Changes the scope. The worker keeps the engine file, the bundles and the index files that it has (also the ones that `findScope()` loaded), and makes a new engine. It loads only the index files that it does not have. |
| `scope` | The current scope. |
| `stop()` | Stops the worker. The next operation starts a new one. |

The module also exports `normalizeSource(source)`, a synchronous function
(see "The source normalizer"), for the app's own cache keys (for example of
SVGs made from the PDF).

### Formats

`buildFormat()` with `mylatexformat` makes a format of a document's own
preamble. Compile the document with it without changes. Only documents with
the same preamble use the format, so it cannot change a document. The format
skips the preamble up to `\begin{document}`, line by line: a document with
`\documentclass` and `\begin{document}` on one line fails ("Two
\documentclass commands").

Build a format after the first compile of a new preamble shows its result,
and keep it under its `formatKey()`. Then the first result does not wait
for the build. The build takes about 0.2 to 0.9 s on a desktop. One
operation runs at a time, so a compile during the build waits for it. An
app can also build the
format of its default preamble (for example, the preamble of its TikZ code
blocks) ahead of time. Each format is 3.6 to 8 MB, so limit the number of
formats in the app's cache. quartz-resources'
[findings](https://github.com/RandomSpaceship/quartz-resources/blob/main/docs/findings/format-cost-measurement.md)
have the measurements.

One operation runs at a time, also `start()`. The others wait in order.
Only `stop()` acts at once, also during a compile.

## Results

`compile()` and `buildFormat()` give an object with a `status`:

| Status | Fields |
|---|---|
| `ok` | `pdf` (or `fmt` for `buildFormat()`). |
| `needs` | `packages`: the packages to install, as `{ name, reason, files, requiredBy }`. `files`: file names that no loaded index has. `errors`: TeX's errors, as in `error` (empty if the scan found the needs). |
| `error` | `errors`: `{ message, line, context }`. `line` is the line of the document, or `null`. A file of an installed package that the worker cannot read (for example a `404`, or a size that is not the size in the index) gives an `error` with the message `could not read <path>: <reason>`, also if TeX made a PDF. |
| `timeout` | `timeoutMs`. The worker was stopped. |
| `crashed` | `message`. The engine aborted, and the worker was stopped. |

The results of a run (all except `timeout` and `crashed`) also have `log`,
`runMs`, and `filesLoaded` and `bytesLoaded` (the files that the run read
with a request). The results of `compile()` also have `packagesRead`: the
packages that the run read. On `ok`, the app can find the mirror packages
among them (the packages without a `releaseArchive`), for its warning.

### The packages of a `needs` result

Each package has a `reason`, in this order of priority:

| `reason` | Why the package is there | Evidence |
|---|---|---|
| `scan` | The scan found a file of the package in the preamble. | `files`: the file names. |
| `log` | TeX stopped, because it did not find a file of the package. | `files`: the file names. |
| `loads` | The measured record of another package lists it (the index's `loads`). | `requiredBy`: that package. |
| `depends` | The `depends` closure of another package lists it, because that package was not measured. | `requiredBy`: that package. |

The app can follow `requiredBy` back to a `log` package. The result has no
download data (sizes, SHA-512, `releaseArchive`): the app reads these from
the index ([`docs/formats.md`](../docs/formats.md), "When a compile needs
packages").

The library finds the other packages in this order: the missing file's own
record, then its package's `loads`, then the `depends` closure. A measured
package in a `depends` closure adds its `loads`, and the closure does not go
through it. The result leaves out the installed packages and the packages
that have files in a bundle. A `scan` or `log` package is always there,
also a bundle package: a bundle has only some of its files. The scan does
not ask for a file that a bundle has.

After `timeout` or `crashed`, the next operation starts a new worker with
the same scope, packages and formats.

An operation rejects its promise if the worker cannot start (for example, a
file at `baseUrl` is missing). The next operation tries the start again.

TeX stops at the first missing file, so a document can need more than one
round of `needs`. Show one progress view for all rounds of a compile.

## The scan

Before each run, the worker scans the preamble: the text up to
`\begin{document}` (or `\dump` in a format source). Without either, it scans
nothing. The scan has its own parser, not the normalizer. It removes all
comments, and it ignores what it does not understand. A mistake costs one
download too many or one more round, never a wrong page: the log finds what
the scan did not.

| Command | `kind` | Files |
|---|---|---|
| `\documentclass`, `\LoadClass` | `class` | `X.cls` |
| `\usepackage`, `\RequirePackage` | `package` | `X.sty` |
| `\usetikzlibrary` | `tikzlibrary` | `tikzlibraryX.code.tex`, else `pgflibraryX.code.tex` |
| `\usepgflibrary` | `pgflibrary` | `pgflibraryX.code.tex` |
| `\usepgfplotslibrary` | `pgfplotslibrary` | `tikzlibrarypgfplots.X.code.tex`, else `pgflibrarypgfplots.X.code.tex` |
| `\input` (`{X}` or `X`) | `input` | `X.tex`, else `X` |

- Each operation is `{ kind, names, options }`, for example
  `{ kind: 'package', names: ['circuitikz'], options: ['european'] }`.
  `operations` is for display: nothing depends on it.
- It splits lists (`\usepackage{a,b}`), and leaves out names with macros
  (`\usepackage{\mypackages}`).
- It does not read the body. A load in the body (for example
  `\usetikzlibrary` in a `tikz` block) is for the log.
- Loads in conditionals (`\iffalse`) are false positives. If the user
  refuses such a download, the app can compile with `scan: false`.

## The source normalizer

`normalizeSource(source)` gives the source as the cache keys see it.
`formatKey()` uses it, and an app can use it for its own keys. The engine
always compiles the original source, so a mistake in the normalizer can
change a key, but never a page. Where the normalizer is not sure, it changes
nothing.

- CRLF becomes LF. It removes the spaces at the end of each line (TeX
  removes them when it reads a line), and the blank lines at the end. The
  result ends with one line end.
- It removes the text of each comment, but it keeps the `%`, so that the
  line end still gives no space. `\%` is not a comment.
- It keeps blank lines inside the text (a blank line is `\par`), and spaces
  inside a line.
- It keeps comments in protected text, where `%` is not a comment:
  - `\verb` and `\verb*`, up to the end of the line;
  - `\lstinline`, `\mintinline` and `\url`, up to the end of the line where
    their braces close;
  - each environment whose name contains `verbatim`, `listing` or `minted`
    (for example `Verbatim` or `lstlisting`), up to its `\end`.
- It removes no comments at all if the source has `\catcode`, or a command
  that makes a verbatim command or environment with another name (for
  example `\MakeShortVerb`, `\DefineVerbatimEnvironment`,
  `\lstnewenvironment`, `\newminted`, `\newtcblisting`, or an xparse
  command such as `\NewDocumentCommand`, which can have a verbatim `v`
  argument).

## Tests

- `tests/*.test.cjs` (Node, check `node`): the engine with both releases of
  the example, the bundles, installs in rounds, scopes, the `needs` result,
  errors, copied text, formats, the scan and the normalizer.
- `tests/browser/` (headless Chromium, check `browser`): the client with the
  real worker: start and progress, two bundles, installs, formats, timeout
  and restart, scope change.

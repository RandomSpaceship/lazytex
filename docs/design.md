# How lazytex works, and why

This file explains each part of lazytex: what it does, and the reasons for
its design. [`formats.md`](formats.md) has the file formats,
[`../library/README.md`](../library/README.md) has the API, and
[`child-repos.md`](child-repos.md) shows how an app builds its own scopes and
bundle on top of lazytex.

The measurements behind the decisions are in the findings of
[quartz-resources](https://github.com/RandomSpaceship/quartz-resources/tree/main/docs/findings),
the repo where lazytex started. This file gives only the main numbers.

## The problem

An app that shows LaTeX documents and TikZ diagrams on the desktop and on
phones needs a TeX engine that runs in a web view, with no server. TeX Live
has about 160,000 files that pdfTeX can read. An app cannot ship or preload
all of them, and most documents read only a few hundred.

lazytex runs pdfLaTeX in WebAssembly, preloads a small bundle of common
files, and loads every other file when TeX first reads it. A file of a package
that is not installed is not visible to TeX, so a compile never waits for the
network: it stops, and the result tells the app which packages to install.

## How a compile works

```
app ── compile(source) ──▶ client (main thread) ──▶ worker ──▶ engine (wasm)
                                                     │
                       scan of the preamble ◀────────┤  1. before the run
                       index files, bundles ─────────┤  2. file nodes
                       synchronous GET of each file ◀┤  3. during the run
                       log parsing, closures ────────┘  4. after the run
```

1. The worker scans the preamble. If it names a file of a package that is not
   installed, the result is `needs`, and the engine does not run.
2. The engine sees a file system with the bundles (preloaded), the generated
   files, and a node for each file of each installed package. The sizes come
   from the index, so `stat` needs no request.
3. When TeX opens a file that is not in a bundle, the file node reads it with
   a synchronous request to the app's base URL. The app serves it from its
   package cache.
4. If TeX stops at a missing file, the library finds the package of the file,
   and the packages that it needs, and returns `needs`. The app installs them
   and compiles again.

## The engine

`engine/default.nix` builds pdfTeX for WebAssembly with the build scripts of
[BusyTeX](https://github.com/busytex/busytex) and TeX Live's own source.

- **Why BusyTeX:** it compiles upstream TeX Live with Emscripten, and it is
  in active development. SwiftLaTeX has had no work since about 2022, is
  AGPL-3.0, and has engine sources of unknown origin. TikZJax is
  unmaintained. Tectonic is native only.
- **Unforked:** the build uses BusyTeX's Makefile with `make` variable
  overrides and its own targets. Nothing in BusyTeX or TeX Live is patched.
  The comments in `engine/default.nix` give the reason for each override.
- **pdfTeX only:** `busytex.wasm` is 1.4 MB (503 KB gzipped). The published
  BusyTeX build has every engine and is 30 MB.
- **Memory grows:** the engine starts with 64 MB and grows to 2 GB at most.
  The published build reserves a fixed 512 MB, which is too much for phones.
- **TeX Live 2026.1 source** (pdfTeX 1.40.29) with nixpkgs' Emscripten. Every
  test page is pixel-identical to the published build's page.
- **A clean build takes about 4 minutes**, because TeX Live's `configure`
  runs only in the 5 package directories that pdfTeX needs.

## The library

`library/` is the TypeScript library that an app imports. It has a client on
the main thread (an async API) and a worker that holds the engine.

- **The engine runs in a Web Worker,** because TeX is synchronous, and a
  file read must block. The worker reads files with synchronous
  `XMLHttpRequest`, which browsers permit only in workers.
- **One engine runs many compiles.** TeX expects to exit after one run, so the
  library undoes what TeX leaves behind: it restores the wasm stack pointer,
  closes the files that TeX left open, and zeroes the memory that TeX used.
- **Its own lazy file nodes,** not Emscripten's `createLazyFile`: half the
  requests, and each compile is 190 to 380 ms faster. Lazy directories make
  their entries on first use, so a start in the full scope does not make
  160,000 nodes. If a lazy file does not load, TeX reads it as an empty
  file and continues. Thus the library records each failed load, and the
  result is an `error`.
- **`ls-R` is necessary.** Without it, kpathsea searches every directory at
  each compile.
- **The scan, the closures and the `needs` result:** TeX stops at the first
  missing file, so each missing package costs a round (a failed compile, an
  install, a new compile). The scan finds most packages before the first run,
  and the measured `loads` records (or TeX Live's `depends`) add the packages
  that those need. In a test with 14 packages, this cut the compiles from 29
  to 12.
- **The normalizer** (`normalizeSource()`) gives the cache keys a form that
  ignores comments and spaces at line ends. It is conservative: where it is
  not sure, it changes nothing, so two documents that TeX reads differently
  never get one key.
- **Formats:** an app can build a format of a preamble on the device and load
  it later. `formatKey()` gives a cache key from the engine, the bundles,
  the index files and the normalized source. A format holds the preamble of
  one document. Only documents with the same preamble use it, so it cannot
  change a document. It helps most for heavy preambles. An app builds it
  after the first compile of a preamble shows its result, or builds the
  format of its default preamble ahead of time.

  lazytex had two other kinds, which it removed:
  - TikZ and packages loaded before the class, for documents of any class
    and preamble. It helped only documents with a preamble of their own, it
    needed a screen of all documents, and an option clash (for example
    `\usepackage[dvipsnames]{xcolor}` after TikZ) can stop a compile.
  - A shared format: a preamble of the app, for all documents of its class
    (in preamble form, with `\endofdump`). Each document got all of its
    entries, and typical notes then changed or stopped. It saved only the
    format build at the first compile of a preamble: about 0.25 to 0.4 s on
    a desktop (quartz-resources'
    [findings](https://github.com/RandomSpaceship/quartz-resources/blob/main/docs/findings/format-cost-measurement.md)).
- On a desktop, the worker is ready about 87 ms after its start, and a warm
  compile takes 1.1 to 1.3 times as long as native pdfTeX.

## Where the TeX files come from

All TeX files come from one frozen TeX Live year (as of writing, 2025,
`tlnet-final`, revision 78234), from nixpkgs. The engine can be newer:
pdfTeX is backward compatible. However, a format must come from the exact
engine build that loads it.

An app gets each file from one of three places:

1. **The bundles:** preloaded, shipped with the app.
2. **Hosted packages:** archives on GitHub releases. lazytex hosts the packages
   of its "hosted" list (with their dependencies) and of its bundle. A child
   repo hosts the packages of its own bundle that lazytex does not host.
3. **Mirror packages:** all other packages. The app downloads TeX Live's own
   archive from a TeX Live mirror, and verifies it against the SHA-512 of
   `texlive.tlpdb` (in the index).

### Why the release hosts packages

- **Pinned versions disappear from normal mirrors,** which keep only the
  current TeX Live. A frozen year is only on the few historic mirrors, and
  they are slow. The release keeps the pinned versions available.
- **Speed and reliability:** GitHub's CDN is fast and nearly always up.
  Volunteer mirrors vary.
- **Less traffic for the volunteer-run mirrors:** GitHub carries the common
  traffic.
- **Consistent results:** the common packages are the same on all devices.

The archives are repacks of nixpkgs' unpacked packages from the Nix binary
cache, so they are not byte-identical to TeX Live's archives, and the index
has their own SHA-512 values. The Nix binary cache has the unpacked packages,
but not TeX Live's original archives, so a repack needs no download from a
TeX Live mirror.

### Hosted packages

The list is in [`texlive/package-sets.json`](../texlive/package-sets.json):

- full documents and figures use the package often;
- pdfTeX can use it (no LuaTeX or XeTeX);
- its archive is small. Big packages stay mirror packages.

`lm` (Latin Modern, 9.5 MB as a repack) is the only large one: full documents
often use `\usepackage[T1]{fontenc}` with `lmodern`. Not in the list:
`fontspec`, `unicode-math` and `tikz-feynman` (they need LuaTeX or XeTeX),
`biblatex` (it needs biber), `natbib` (not useful without a BibTeX binary),
`cm-super` (65 MB: documents that use T1 without `lmodern` load it), and
`minted` (it needs shell escape and Python).

## Scopes and layers

A scope is the set of packages that the engine can see, as a list of index
files (layers). lazytex's index has one layer, `index-full.json`: all of TeX
Live without the ConTeXt, LuaTeX and XeTeX collections (161,329 files, 7.9 MB
of JSON before compression).

An app starts in a smaller scope, because each compile reads `ls-R` and
`pdftex.map` of the scope, and a smaller index loads faster. A child repo
narrows the full index into layers (`index/narrow_index.py`). For example,
quartz-resources has `medium` (2,830 packages, 27,298 files, 1.8 MB) and
`full-extra` (all other packages).

- **Why layers:** a change from `medium` to the full scope then loads only
  `index-full-extra.json`, and the worker keeps the parsed `medium` layer. The
  `medium` entries are not stored twice.
- **The generated files belong to the scope,** not to a layer: `ls-R`,
  `pdftex.map` and `language.dat` change with the set of packages. A child's
  layer gets them from a TeX tree with exactly the packages of its scope
  (`texlive.treeOf`). The last layer, if it completes the full scope, uses
  lazytex's generated files.
- **The library knows no scope names.** The app gives its scopes, and
  `findScope()` finds the smallest one that has a list of files.

## Bundles

A bundle holds the files that representative documents read: the build
compiles the documents of a bundle definition with the engine, and records
each file that the runs read (`bundle/trace_bundle.cjs`). Nobody picks files
by hand: to add files, add a document.

- **Why traced files, not whole packages:** a bundle of whole packages costs
  more to preload and saves no requests.
- **Two bundles in layers:** lazytex's bundle has the files that documents of
  all kinds share (the LaTeX kernel, the standard classes, `amsmath`,
  `standalone`), and `pdflatex.fmt`, because a format must come from the
  engine build that loads it. An app's bundle has the files of its own
  documents (for example TikZ and its libraries), without the files of
  lazytex's bundle.
- **Not the inputs of `pdflatex.fmt`:** the bundle ships the format, so the
  device never reads its inputs (mostly hyphenation patterns).
- **The bundle rule of the closures:** a closure leaves out the packages that
  have files in a bundle, because the bundle has the files that their usual
  documents read. If a document needs another file of one of them, the scan
  or the log names it.

## Platform requirements

- **Synchronous `XMLHttpRequest` from a worker to the app's files.** It works
  with `arraybuffer` responses on WebView2 (Windows) and Android System
  WebView, with Tauri custom URL schemes. If a web view does not permit it,
  the fallbacks are a `SharedArrayBuffer` and `Atomics.wait` helper (needs
  cross-origin isolation), JSPI, or an Asyncify build of the engine.
- **Android:** each request over a Tauri custom scheme costs about 9 to 15
  ms. The bundles keep the number of requests low.
- **WebKit (macOS, iOS)** is not tested.

## Licences

lazytex's own code is under the MIT licence. A release also has other
people's work, with other licences:

- **The engine** links pdfTeX (GPL-2.0-or-later), xpdf (GPL-2.0 or 3.0),
  kpathsea (LGPL-2.1-or-later), permissive libraries, BusyTeX's `busytex.c`
  (MIT) and Emscripten's runtime. lazytex distributes it under
  GPL-3.0-or-later. With GPL-3, the corresponding source can be on another
  server, if the directions to it are clear. Thus a site with the engine
  (for example the example page on GitHub Pages, which has a size limit of
  1 GB) can point to the source and does not have to hold it. The TeX Live
  source alone is 149 MB.
- **The engine build** writes `NOTICE.html` (the parts, their licences and
  the exact source references) and `licenses/` (the licence texts, taken
  from the sources of the build). The release has them in `busytex/`.
- **The TeX files** are unchanged files of TeX Live packages, each under its
  own licence. Most packages are LPPL. The LPPL permits a "Compiled Work"
  (clause 3): the installed files of a package, if a recipient can install
  them exactly as the package installs them. A part of a package is a
  modification (clause 2). Thus:
  - **A release archive** holds all runfiles of its package (the
    `runfiles` of `texlive.tlpdb`), also the files that pdfTeX does not
    read. It is a repack of nixpkgs' tree, not TeX Live's own archive. On
    2026-10-19, `tools/check_mirror_download.py --tree --all-hosted`
    found each runfile of the 86 hosted packages with the same bytes as in
    TeX Live's archives. The repack keeps the builds away from the
    volunteer mirrors. Its SHA-512 differs from TeX Live's, and the index
    has a hash for it (`releaseArchive`). If a later nixpkgs pin changes a
    file, the archives are no longer unchanged copies: run the check after
    each change of the pin, and solve a difference then.
  - **A bundle** holds only the files that its documents read, so it is a
    part of each package. The LPPL permits this as a derived work (clause
    6), because no file is changed and the release's `NOTICE.html` tells how
    to get the complete packages.
  - Some packages have conditions that runfiles alone do not meet: the GPL
    packages need their source (often a `.dtx` file), and some MIT, BSD and
    OFL packages have their licence text only in their documentation. TeX
    Live's historic archive keeps the source and documentation containers
    of each package. The release's `NOTICE.html` points to them, as a TeX
    Live redistributor usually does. The index records no licence for each
    package.
- **BusyTeX** says in its README that its code is MIT, but it has no
  licence file, and its releases have no source or notices.

## A possible change: current TeX Live

Now everything comes from nixpkgs' frozen TeX Live year. A later version
could take the TeX files from current TeX Live instead:

- A snapshot job downloads `texlive.tlpdb` and the package archives from CTAN
  once, and uploads them to a release. Every build then fetches from that
  release, with the SHA-512 values of `tlpdb` as fixed hashes.
- The release could host TeX Live's original archives without change. Their
  SHA-512 is then the one in `tlpdb`, so the index needs no hashes of its own,
  and an app can get the same file from GitHub or from a mirror.
- Mirror packages then come from current TeX Live, and the app verifies them
  against the current `tlpdb` (with TeX Live's GPG signature).
- lazytex must then make `pdftex.map` and `language.dat` itself, which
  nixpkgs does now.

This is a large change to how the index, the trees and the archives are
built. It is not planned.

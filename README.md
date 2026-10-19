# lazytex

pdfLaTeX in WebAssembly for browsers and web views, with TeX files that load
on demand.

lazytex compiles LaTeX documents and TikZ diagrams to PDF in a Web Worker,
with no server. It preloads a small bundle of common files, and the engine
reads every other file of TeX Live when TeX first opens it. A compile never
waits for the network: when a document needs a package that is not
installed, the result says which packages to install, and the app compiles
again.

The engine is pdfTeX, built with the scripts of
[BusyTeX](https://github.com/busytex/busytex) from TeX Live's source, without
a fork. lazytex adds the lazy file loading, the index of TeX Live, the
bundles, the hosted packages and the library around it. The name is from
"lazy loading" and BusyTeX.

## Quick start

Requirements: [Nix](https://nixos.org/download/) with flakes.

```sh
nix run .#example
```

This builds the engine, the TeX resources and an example app, and serves a
page on <http://127.0.0.1:8050/>. Type a document, and press
**Compile**. The first build takes some time (the TeX trees come from the
Nix binary cache, and the engine takes about 4 minutes to compile).

`nix build .#example-pages` makes the same page as a static site for GitHub
Pages. It has only the packages of the medium scope.

## What a release has

| Part | What it is | Docs |
|---|---|---|
| Engine (`busytex/`) | pdfTeX in WebAssembly, 1.4 MB (503 KB gzipped). Memory starts at 64 MB and grows. | [`docs/design.md`](docs/design.md), "The engine" |
| Library (`js/`) | The TypeScript API for apps: a client on the main thread and the engine's worker. | [`library/README.md`](library/README.md) |
| Bundle (`bundle.tar`) | The files that general documents read (the LaTeX kernel, the standard classes, `amsmath`, `standalone`), and `pdflatex.fmt`. The worker preloads it. | [`docs/design.md`](docs/design.md), "Bundles" |
| Index (`index/index-full.json`) | Every TeX Live file that pdfTeX can read (161,329 files), with its package and size, and the generated files (`ls-R`, `pdftex.map`, `language.dat`). | [`docs/formats.md`](docs/formats.md) |
| Hosted packages (`archives/hosted/`) | Archives of common packages (for example `pgfplots`, `hyperref`, `siunitx`), so that most installs come from GitHub, not from the TeX Live mirrors. | [`docs/design.md`](docs/design.md), "Where the TeX files come from" |
| Manifest (`manifest.json`) | Each file with its size and SHA-512, and the upstream versions. | [`docs/formats.md`](docs/formats.md) |

## Use it in an app

1. Ship or download the release files, verify them against `manifest.json`,
   and serve them at a base URL that a worker can read with synchronous
   requests (for example a custom URL scheme of the app).
2. Serve the files of installed packages from a package cache at
   `texlive/texmf-dist/`.
3. Import `js/client.js`, and run the compile loop: compile; on `needs`,
   install the packages (or change the scope) and compile again.

[`library/README.md`](library/README.md) has the API and the loop, and
[`example/web/app.js`](example/web/app.js) is a working page.

## Build your own scopes and bundle

An app usually wants a smaller default scope and a bundle of its own typical
documents (for example TikZ). A **child repo** builds them with lazytex's Nix
functions, and publishes them in its own release, which uses the engine, the
library and the hosted packages of lazytex's release.
[`docs/child-repos.md`](docs/child-repos.md) shows how, with a minimal flake.
[`example/`](example/) is a complete minimal child, and
[quartz-resources](https://github.com/RandomSpaceship/quartz-resources) is a
real one.

## Repo layout

| Path | What it is |
|---|---|
| `engine/` | The engine build (BusyTeX's Makefile, with overrides). |
| `library/` | The library (TypeScript), with its API in `README.md`. |
| `texlive/` | The pinned TeX Live: the package sets, the hosted list, and a TeX tree builder for child repos. |
| `index/` | The full index (`make_index.py`), the narrowing for child repos (`narrow_index.py`), and the `loads` measurement (`measure_loads.cjs`). |
| `bundle/` | The bundle trace and pack tools, and lazytex's bundle documents. |
| `archives/` | The repacks of the hosted packages. |
| `release/` | The release files and their check. |
| `nix/lib.nix` | The build functions (flake output `lib.<system>`), for lazytex and for child repos. |
| `example/` | A minimal child: an app's scopes, bundle, release and web page. The tests run on it. |
| `tests/` | The Node tests and the browser test of the library. |
| `tools/` | Tools to run by hand: `closure_sizes.py` (what a package adds to the hosted list) and `check_mirror_download.py` (a real download from a TeX Live mirror). |
| `docs/` | The design, the formats with their JSON Schemas, and the guide for child repos. |

## Commands

| Command | What it does |
|---|---|
| `nix flake check` | All tests: the release checks, the Node tests and the browser test. |
| `nix build .#release` | lazytex's release files, with the tag `development`. |
| `nix run .#release-assemble -- TAG OUT` | The release files for a tag, checked (the release workflow). |
| `nix build .#engine` | The engine only. |
| `nix build .#library` | The library only. |
| `nix run .#example` | The example page. |
| `nix develop` | A shell with Python, Node, TypeScript, esbuild, Chromium and `pdftoppm`. |

## Status

- The engine, the library, the index, the bundle, the hosted packages and the
  release files are built and tested (2026-10-19).
- No release is published yet. The release workflow (GitHub Actions, the
  source archives that the GPL needs, and the asset names of the files other
  than the package archives) is not built.
- The TeX files come from the frozen TeX Live 2025 (`tlnet-final`), as
  nixpkgs packages it.

## Licences

- **lazytex's own code** (the library, the tools, the build files and the
  docs) is under the MIT licence ([`LICENSE.md`](LICENSE.md)).
- **The engine** (`busytex.js`, `busytex.wasm`) is pdfTeX and its libraries,
  under GPL-3.0-or-later. pdfTeX is GPL-2.0-or-later, which permits this.
- **The TeX files** (bundles, archives, the TeX tree of the example site) are
  unchanged files of TeX Live packages, each under its own licence.

Each release has a `NOTICE.html`, and `busytex/NOTICE.html` with the engine's
licence texts. They tell where the source of each part is.

## A possible change: current TeX Live

Now all TeX files come from nixpkgs' frozen TeX Live year. A later version
could take them from current TeX Live: a snapshot job would download
`texlive.tlpdb` and the package archives from CTAN once, and host them, and
the builds would use that snapshot. The release could then host TeX Live's
original archives, verified by the SHA-512 values of `tlpdb`, and mirror
packages could come from current TeX Live. This is a large change to how the
index, the trees and the archives are built, and it is not planned.
[`docs/design.md`](docs/design.md) has the details.

# AGENTS.md

Instructions for AI coding agents and human contributors who work on
**lazytex**. [`README.md`](README.md) says what lazytex is, and
[`docs/design.md`](docs/design.md) says how it works and why.

## What this repo is

lazytex ([GitHub](https://github.com/RandomSpaceship/lazytex)) builds pdfLaTeX
in WebAssembly, a TypeScript library around it, an index of TeX Live, a
general bundle, and archives of common packages, and publishes them as one
release. Apps use the release directly, or through a **child repo** that
builds their own scopes and bundle with lazytex's Nix functions
([`docs/child-repos.md`](docs/child-repos.md)).

The first user is the [quartz](https://github.com/RandomSpaceship/quartz)
note-taking app, through its child repo
[quartz-resources](https://github.com/RandomSpaceship/quartz-resources).
lazytex started in that repo, and its findings (the measurements behind the
design) are there, in `docs/findings/`. Do not copy measurement results into
this repo: link to them.

Status (2026-10-19): everything builds and passes its tests. No release is
published. The release workflow is not built.

## Environment

- Nix flakes. Every build must be easy to repeat, on a developer's machine and
  on GitHub Actions. Pin toolchains in `flake.nix`.
- `flake.nix` follows the latest stable NixOS branch (`nixos-26.05`). Change
  it at each NixOS release. Do not use `nixpkgs-unstable` unless an up-to-date
  program is critical. Ask the maintainer first.
- A child repo uses `nixpkgs.follows = "lazytex/nixpkgs"`, so that its TeX
  trees come from the same TeX Live as lazytex's index. A change of the
  nixpkgs pin is a change for every child.
- Byte-identical output is good to have, but not required.
- Put scratch work in the git-ignored `.scratch/`. Stage new files with
  `git add`, so that the flake can see them.
- Commit at the end of each stage of work. Start every commit subject and PR
  title with `[AI] `, and every GitHub comment with 🤖. Write a body that
  tells what changed, why, and the results. Do not push: the maintainer
  pushes.
- When you run `nix flake check` through a pipe (for example `| tail`), read
  the exit code of `nix`, not of the pipe.
- GitHub Actions runs `nix flake check` on each push
  (`.github/workflows/check.yml`), with our own outputs kept in the GitHub
  Actions cache.

## Commands

- `nix flake check`: all tests (release checks, Node tests, browser test).
- `nix build .#release`: lazytex's release files (tag `development`).
- `nix run .#release-assemble -- TAG OUT`: the release files for a tag, checked.
  It uses the `loads` records of all packages.
- `nix build .#release-full`: the release files with the `loads` records of
  all packages (`.#loads-full`). CI builds it after `nix flake check`. It
  takes about 8 minutes on 16 threads, so local work uses `.#release`
  (the hosted packages only).
- `nix build .#engine`, `.#library`, `.#index`, `.#bundle`, `.#archives`, `.#loads`: one part.
- `nix build .#example-release`, `.#example-site`: the example child.
- `nix build .#pages`: the demo site (`pages/`), with the medium tree only,
  for GitHub Pages (`.github/workflows/pages.yml`, which starts after each
  successful check of a push to `main`). `nix run .#pages` serves it.
- `nix run .#example`: the example page on <http://127.0.0.1:8050/>.
- `nix develop`: a shell with the tools.

## Principles

1. **Use upstream unforked.** Build BusyTeX and TeX Live from their official
   sources. Change their behaviour only with build settings (`make`
   variables) and our own wrapper code. Keep patches to an absolute minimum,
   document each one, and send fixes upstream where possible.
2. **Release matching pieces together.** The engine, its JS loader, the
   bundle and `pdflatex.fmt` (which that engine made) come from one build, in
   one versioned release with a manifest.
3. **Manifest and SHA-512.** Every release has a `manifest.json` with each
   file's size and SHA-512, and the upstream versions. All hashes are
   SHA-512.
4. **Licence compliance.** lazytex's code is MIT. The engine is distributed
   under GPL-3.0-or-later (pdfTeX is GPL-2.0-or-later), so its corresponding
   source can be on another server. Every release and every site that has
   the engine must have the notices (`NOTICE.html`, `busytex/NOTICE.html`,
   `busytex/licenses/`) and the corresponding source must stay available.
   The TeX files are unchanged TeX Live files under their packages'
   licences. Do not change them. A release archive holds all runfiles of
   its package in `texmf-dist` (an LPPL compiled work), and no runfiles of
   TeX Live's installer and `tlmgr` (`tlpkg/` and the TeX Live root).
   `make_archives.py` stops if an LPPL package has such runfiles. After
   each change of the nixpkgs pin, run
   `tools/check_mirror_download.py --tree --all-hosted` (its docstring has
   the command): the files must stay TeX Live's bytes.
5. **Measure, do not guess.** Record each number with the conditions of its
   measurement (in quartz-resources' findings).
6. **Android is a target, WebKit is best effort.** Watch memory, download
   size and request counts. Nobody tests macOS or iOS.
7. **The engine never waits for the network.** A compile that needs packages
   returns `needs`; the app downloads.

## Interfaces

These are interfaces for apps and child repos. Tell the maintainer before a
change to them:

- the library's API ([`library/README.md`](library/README.md));
- the formats of the release, index and archive files
  ([`docs/formats.md`](docs/formats.md), and the JSON Schemas in `docs/`);
- the functions of [`nix/lib.nix`](nix/lib.nix) (child repos call them).

The index and manifest formats are at `"version": 1`. Nothing is published
yet, so changes do not bump it. After the first release, a change that an
old reader cannot read needs a new version.

## Repo layout

[`README.md`](README.md), "Repo layout", lists each folder. Some points that
the code does not show:

- `example/` is the test fixture of `tests/` and the walkthrough of
  `docs/child-repos.md`. Keep the three in agreement. Keep its page
  (`example/web/`) the shortest complete compile loop.
- `pages/` is the demo site on GitHub Pages. It uses the example child's
  release, and adds progress, a status, a stop button, a timer, and a PDF
  preview with PDF.js (pinned in `pages/default.nix`).
- The tests use three document folders, joined into one directory by
  `flake.nix`: `tests/documents/` (test cases), `example/documents/` (the
  example's bundle documents) and `bundle/documents/` (lazytex's bundle
  documents).
- Each tool in `index/`, `bundle/`, `archives/`, `release/` and `tools/` has its
  command in its docstring, so that it runs without Nix too.

## Bundles: how their files are chosen

Nobody picks files by hand. `bundle/trace_bundle.cjs` compiles the documents
and format builds of a bundle definition, and records each file that they
read. To add files, add a document.

- Keep lazytex's bundle documents (`bundle/documents/`) general: the kernel,
  the standard classes, `amsmath`, `standalone`. App-specific documents go
  into the app's bundle.
- One file in a bundle makes its whole package a hosted archive.
  `make_archives.py` fails for a bundle package larger than 20 MB. For
  example, an `itemize` bullet in an 11pt article is a TS1 glyph, and it
  brings in `cm-super` (65 MB): `bundle/documents/article.tex` uses
  `enumerate` for this reason.

## Open points

- The release workflow: GitHub Actions builds the release, attaches the
  engine's source archives (the TeX Live source, BusyTeX at its commit,
  lazytex at the release tag), and publishes it. The asset names of the
  files other than the package archives are not decided.
- The time of `.#release-full` in CI is not measured yet. If it comes near
  the job timeout (120 min), divide the packages into groups in matrix jobs.
- The example page does not download packages. `example/README.md` has notes
  on how a web page can do it.
- A move to current TeX Live (README, last section): not planned.
- Possible work on the demo site (`pages/`):
  - Keep the downloaded files after a stop. A service worker can keep the
    engine, the index, the bundles and the TeX files in Cache Storage.
    Find out first if the synchronous requests of the worker go through a
    service worker.
  - Keep the compiled `WebAssembly.Module` and the unpacked bundles on the
    main thread, and give them to each new worker. Measure first how much
    time this saves.

# Release, index and archive formats

This file describes the files of a lazytex release and of a child release:
what each file holds, and how an app uses it. JSON Schemas:
[`index.schema.json`](index.schema.json) and
[`release-manifest.schema.json`](release-manifest.schema.json). The release
check (`release/check_release.py`) checks each build against them.

Apps read these files, so a change to them is an interface change.

## Terms

| Term | Meaning |
|---|---|
| Package | A TeX Live package, for example `pgfplots`. TeX Live distributes each package as one archive (`.tar.xz`). |
| Layer | One index file. A layer holds only the packages that the layers under it do not have. |
| Scope | The set of files that the engine can see: a list of layers, the lowest first. lazytex's full scope is one layer, `index-full.json`. A child repo makes its own scopes, for example `medium` (`index-medium.json`) and full (`index-medium.json` and `index-full-extra.json`). |
| Tree | A folder of TeX files in the engine's file system: `texmf-dist` (the packages) or `texmf-var` (generated files). |
| Generated file | A file that is in no package and that depends on the set of packages: `ls-R` (kpathsea's file list), `pdftex.map` and `language.dat`. |
| Bundle | A tar of files that the engine preloads. Bundles also come in layers: lazytex's `bundle.tar`, then an app's `bundle-<app>.tar`. |
| Hosted package | A package that a release hosts as its own archive. |
| Mirror package | A package that no release hosts. The app downloads TeX Live's archive of it from a TeX Live mirror. |
| Parent release | For a child release: the lazytex release that it uses (the engine, the library, `bundle.tar`, and the hosted packages). |

All hashes are SHA-512, as 128 lowercase hex digits.

## The files of a release

lazytex's release:

| Path | Use |
|---|---|
| `manifest.json` | Every other file, with its size and SHA-512, and the upstream versions. |
| `NOTICE.html` | The licences of the release's parts, and where their source is. A child release has its own. |
| `busytex/busytex.js`, `busytex/busytex.wasm` | The engine. |
| `busytex/NOTICE.html`, `busytex/licenses/` | The engine's parts, their licences and their source, and the licence texts. |
| `js/client.js`, `js/worker.js`, `js/types/`, `js/LICENSE.txt` | The library: the API for apps, the engine's worker, the TypeScript declarations, and lazytex's licence (MIT). See [`library/README.md`](../library/README.md). |
| `bundle.tar` | lazytex's bundle. It includes `pdflatex.fmt`. |
| `index/index-full.json` | The full scope in one layer: every package that the engine can read. |
| `index/generated/full/<tree>/<path>` | The generated files of the full scope. |
| `archives/hosted/<package>.r<revision>.tar.xz` | The archives of the hosted packages. |

A child release (for example an app's):

| Path | Use |
|---|---|
| `manifest.json` | Every file of the child release, and the files that the app uses from the parent release (marked `"parent": true`), with their sizes and SHA-512. |
| `bundle-<app>.tar` | The app's bundle. No file of it is in `bundle.tar`. |
| `index/index-<layer>.json` | The app's layers, narrowed from the parent's `index-full.json`. |
| `index/generated/<layer>/<tree>/<path>` | The generated files of each scope. |
| `archives/hosted/<package>.r<revision>.tar.xz` | The archives of the packages that the child hosts and the parent does not. |
| `archives/<layer>.tar.xz` | Optional: all files of one layer, for offline use. |

### Where each file comes from

The repo holds only source: lazytex's code, the build files and the bundle
documents. The build makes every file of a release. Each file is one of
these kinds:

| Kind | Files | Made by |
|---|---|---|
| **TeX Live files, unchanged** | The files in `bundle*.tar` (not `pdflatex.fmt`), in `archives/hosted/` and in `archives/<layer>.tar.xz` | The files come from nixpkgs' TeX Live and have the same bytes as TeX Live's own archives. `make_archives.py` and `make_bundle.py` pack them into new tar files. An archive holds all runfiles of its package. A bundle holds only the files that its documents read. |
| **Made from TeX Live files** | `index/generated/` (`ls-R`, `pdftex.map`, `language.dat`), `pdflatex.fmt` in `bundle.tar` | `ls-R`: `make_index.py` and `narrow_index.py`. `pdftex.map` and `language.dat`: nixpkgs (updmap and the hyphenation configuration) for each TeX tree. `pdflatex.fmt`: the engine, from LaTeX's `pdflatex.ini` (`trace_bundle.cjs`). |
| **Compiled from upstream source** | `busytex/busytex.js`, `busytex/busytex.wasm`, `busytex/licenses/` | `engine/default.nix`, from the TeX Live source, BusyTeX and Emscripten. The licence texts are copies from those sources. |
| **lazytex's code and data** | `js/`, `index/index-*.json`, `manifest.json`, `NOTICE.html`, `busytex/NOTICE.html` | The library build (`library/default.nix`), the index tools, `make_release.py`, and `engine/NOTICE.html`. The index files hold data from TeX Live's package database (`texlive.tlpdb`). |

The app serves the files of both releases in one directory, at these paths
(`appSite` in [`nix/lib.nix`](../nix/lib.nix) makes this directory for the
tests). It ships or downloads once the engine, the library, the bundles, the
index files and the generated files. It downloads a TeX package only when a
compile result asks for it (`needs`, see below), never during a compile.

### Release names and asset names

- The release name in `manifest.json` is the git tag of the GitHub release.
  The Nix build uses the tag `development`, which is never published. The
  release workflow writes the files again with the real tag (the assemble
  app: `nix run .#release-assemble -- TAG OUT` for lazytex), and checks them.
- GitHub release assets cannot be in folders. The asset name of a package
  archive is its file name, for example `pgf.r78116.tar.xz`. So the URL of
  each archive is known before the upload. The asset names of the other files
  are not decided yet.

## Index files

`index-full.json` (shortened):

```json
{
  "format": "lazytex-index",
  "version": 1,
  "scope": "full",
  "texlive": { "year": 2025, "revision": 78234, "frozen": true },
  "trees": { "texmf-dist": "/texlive/texmf-dist", "texmf-var": "/texlive/texmf-var" },
  "packages": {
    "pgf": {
      "revision": 78116,
      "archiveBytes": 718196,
      "sha512": "872356a5…",
      "releaseArchive": { "url": "https://github.com/RandomSpaceship/lazytex/releases/download/v1.0.0/pgf.r78116.tar.xz", "bytes": 714116, "sha512": "…" },
      "depends": ["atveryend", "fp", "graphics", "pdftexcmds", "xcolor"],
      "loads": ["amsfonts", "epstopdf-pkg", "graphics", "graphics-cfg", "graphics-def", "kpathsea", "l3backend", "latex", "latexconfig", "xcolor"],
      "files": {
        "tex/latex/pgf/basiclayer/pgf.sty": 1090,
        "tex/latex/pgf/utilities/pgfkeys.sty": { "bytes": 274, "loads": ["amsfonts", "kpathsea", "l3backend", "latex"] },
        "…": 0
      }
    }
  },
  "generated": {
    "texmf-dist": { "ls-R": 3996424 },
    "texmf-var": { "ls-R": 259, "fonts/map/pdftex/updmap/pdftex.map": 5541221, "tex/generic/config/language.dat": 6767 }
  }
}
```

A layer above the lowest one has `"extends"` (the name of the layer under it)
and no `trees`.

| Key | Meaning |
|---|---|
| `scope` | The name of the layer. The file is `index-<scope>.json`. |
| `extends` | The layer under this one. Not in the lowest layer. |
| `texlive` | The TeX Live release of the packages: year, revision of `texlive.tlpdb`, and `frozen` for a final release. |
| `trees` | Where each tree is in the engine's file system. Only in the lowest layer. |
| `packages.<name>.revision` | The package's TeX Live revision. |
| `packages.<name>.archiveBytes` | The size of TeX Live's archive of the package. |
| `packages.<name>.sha512` | The SHA-512 of TeX Live's archive, from `texlive.tlpdb`. |
| `packages.<name>.releaseArchive` | Only if a release hosts the package: the archive's URL, its size and its SHA-512. The URL is a GitHub release asset, `https://github.com/<owner>/<repo>/releases/download/<tag>/<file name>`, in this release or in the parent release. This archive is not byte-identical to TeX Live's archive. |
| `packages.<name>.depends` | Optional. The packages that this package needs: TeX Live's `depend` entries, without collections and without packages that the index does not have. Only the direct dependencies, so the reader computes the closure. Each name is in the same layer or in a layer under it. |
| `packages.<name>.loads` | Optional. Present only if the package was measured, and then also when it is empty. All the packages that the measured documents of the package read (not only the direct ones), without the package itself, in alphabetical order. See "Measured loads". |
| `packages.<name>.files` | The package's files that pdfTeX can read, by path relative to `texmf-dist`. Each entry is the file's size, or `{ "bytes", "loads" }` for an entry file whose measured set is not the same as the package's `loads`. |
| `generated` | The generated files of the scope that ends at this layer, by tree and path, with their sizes. Each file is at `index/generated/<scope>/<tree>/<path>`. |

- The index has only the files that pdfTeX can read: the `tex`, `fonts` and
  `web2c` folders, without the folders of other engines (`excludePaths` in
  [`texlive/package-sets.json`](../texlive/package-sets.json)). The
  ConTeXt, LuaTeX and XeTeX collections are not in the index.
- A reader must accept both forms of a file entry: a size, or an object with
  `bytes` and `loads`.
- A child's layers copy the entries of `index-full.json` without change. A
  child adds only a `releaseArchive` or `loads` for a package that it hosts
  and the parent does not.

### Generated files of a scope

The generated files belong to a scope, not to a layer, because they change
with the set of packages. The library takes them from the last layer of the
scope. `ls-R` of a scope lists the files of all its layers, and `pdftex.map`
comes from a TeX tree with exactly the packages of the scope. Do not use the
generated files of a larger scope in a smaller one: in a typical medium scope,
the full `ls-R` is 4.0 MB instead of 0.57 MB, and pdfTeX reads `pdftex.map`
(5.5 MB instead of 0.39 MB) at each compile.

### Measured loads

`index/measure_loads.cjs` measures the hosted packages, and the release step
writes the records into the index. For each entry file of a package, the
measurement compiles a small document with all packages installed, and
records the packages that the run opened:

| Entry file | Document |
|---|---|
| `<name>.sty` | `\documentclass{article}\usepackage{<name>}` |
| `<name>.cls` | `\documentclass{<name>}`, with an empty body |
| `tikzlibrary<name>.code.tex` | `\usepackage{tikz}\usetikzlibrary{<name>}` (`pgfplots` instead of `tikz` for the libraries of pgfplots) |

- A run counts only if it has no error and reads the entry file itself.
  Obsolete files, LuaTeX-only libraries and files of the same name in another
  package do not count.
- The most frequent set of a package is its `loads`. On a tie, the set of its
  main file (`<name>.sty`, then `<name>.cls`) is used. Each entry file with a
  different set gets its own record in `files`.
- A package with no entry files (for example `cm`) gets an empty `loads`.
- A package whose entry files all fail does not get `loads`. It stays "not
  measured" (for example `atveryend`: LaTeX loads its own file for
  `\usepackage{atveryend}`).
- A record is a lower bound. Package options and later commands can load more
  files. The scan and the log find the rest.
- The library's lookup for a missing file: the file's record, else its
  package's `loads`, else the `depends` closure.

## The release manifest

```json
{
  "format": "lazytex-release",
  "version": 1,
  "release": "v1.0.0",
  "repository": "RandomSpaceship/lazytex",
  "upstream": {
    "busytex": "eb36aae169f7d71e70760a84ef80156b33c0f820",
    "texliveSource": "https://github.com/TeX-Live/texlive-source/archive/refs/heads/tags/texlive-2026.1.tar.gz",
    "emscripten": "5.0.6",
    "texliveData": { "year": 2025, "revision": 78234, "frozen": true }
  },
  "files": {
    "bundle.tar": { "bytes": 4935680, "sha512": "…" },
    "…": {}
  }
}
```

A child's manifest also has `parent`, and its `files` has the parent files
that the app needs:

```json
{
  "release": "v2.1.0",
  "repository": "example-owner/example-app-resources",
  "parent": { "repository": "RandomSpaceship/lazytex", "release": "v1.0.0", "manifestSha512": "…" },
  "files": {
    "bundle-example.tar": { "bytes": 1720320, "sha512": "…" },
    "bundle.tar": { "bytes": 4935680, "sha512": "…", "parent": true },
    "busytex/busytex.wasm": { "bytes": 1414166, "sha512": "…", "parent": true },
    "…": {}
  }
}
```

- `files` lists every file of the release except `manifest.json`. The app
  verifies each file that it downloads against this list.
- A file with `"parent": true` is not in the child release. The app gets it
  from the parent release (`parent.repository` and `parent.release`), at the
  same path.
- `formatKey()` of the library reads the manifest at the app's base URL, so
  for a child, the child's manifest: it lists all files that the key needs.

## Archives

Each archive is a `tar` file, compressed with `xz`. Each entry is a file at
its path relative to `texmf-dist`, for example
`tex/latex/pgfplots/pgfplots.sty`. TeX Live's own archives use the same
paths (a package that TeX Live does not relocate, for example `kpathsea`,
has them below `texmf-dist/`), and they also have a `tlpkg/` folder.

- A release archive has all runfiles of the package (its `runfiles` in
  `texlive.tlpdb`): the files that the index lists, and the files for other
  programs, for example makeindex styles. It is a repack of the unpacked
  package from the Nix binary cache, so it is not byte-identical to TeX
  Live's archive, but its files are. Verify it with
  `releaseArchive.sha512`.
- A TeX Live archive has the same runfiles and a `tlpkg/` folder. Verify it
  with the package's `sha512`.

In both cases the app writes only the files that the index lists (see
"Safety rules for unpacking").

## Bundles

A bundle is an uncompressed tar file in the ustar format. Each entry is a
regular file at its path in the engine's file system, without the leading
`/`: for example `texlive/texmf-dist/tex/latex/base/article.cls`, and
`home/web_user/fmt/pdflatex.fmt` (only in lazytex's bundle). A bundle has no
generated files, and no two bundles have the same file.

The files of a bundle are the files that representative documents read: the
build compiles the documents and format builds of a bundle definition
(`bundle-documents.json`), and records each file that the runs read
(`bundle/trace_bundle.cjs`). Not the inputs of `pdflatex.fmt`, because the
device never builds it. A child's bundle leaves out the files of the bundles
under it.

The engine reads a bundle with `readTarBundle()`
(`library/src/filesystem.ts`). Each file stays a view into the tar's bytes,
so nothing is copied. The tar is not compressed, so that the reader stays
small. Compression during transport (HTTP) or in the app's package does that
work.

## How an app uses the files

### At engine start

1. Give the library the scope (the index files), the bundles, and the list of
   the packages in the app's package cache.
2. The worker loads the index files and the bundles, and preloads the
   bundles.
3. The engine sees the files of the bundles, the generated files, and the
   files of the installed packages. It reads each file that is not in a
   bundle with a synchronous request to the app's base URL, at the file's
   path in the engine's file system. The files of other packages are not
   visible to TeX.

### When the engine requests a file

1. A generated file comes from the local copy of `index/generated/`.
2. A package file comes from the local package cache. The engine requests
   only files of installed packages. The request never starts a download.

### When a compile needs packages

The engine never waits for the network. Before each run, the library scans
the preamble. It maps each file that the preamble loads to its package with
the index. After a run, it does the same for the file at which TeX stopped.
The result tells the app what to do:

- **`needs`:** the file is in a package of the current scope that is not
  installed. The result lists that package, and the packages that it needs
  (from the `loads` records, else from `depends`) that are not installed and
  not in a bundle. Each package has a `reason`. The result has no download
  data: the app reads it from the index. See
  [`library/README.md`](../library/README.md).
- **`needs` with `files`:** no loaded index has the file. The app can look
  for it in a larger scope (see below). If no scope has it (for example a
  wrong package name), the app shows the errors of the result.

For the packages of `needs`, the app:

1. Shows the packages, and their sizes and source from the index. A package
   without a `releaseArchive` comes from the TeX Live mirrors (a mirror
   package). Show a warning for it, because the result can differ between
   devices and over time.
2. Downloads each archive asynchronously, with progress, and lets the user
   cancel:
   1. If the package has a `releaseArchive`, download `releaseArchive.url`,
      and verify its SHA-512 against `releaseArchive.sha512`.
   2. If not, download `archive/<name>.r<revision>.tar.xz` from a TeX Live
      historic mirror (`<mirror>/systems/texlive/<year>/tlnet-final/`), and
      verify its SHA-512 against the package's `sha512`.
3. Unpacks each archive into the cache's `texmf-dist/`, with the safety rules
   below.
4. Tells the engine the new packages (`packagesInstalled()`), and compiles
   again. One document can need more than one round, if it uses unrelated
   packages that are not installed.

### Safety rules for unpacking

Archives from the mirrors come from outside, so treat every archive as
untrusted, also after the hash check:

1. Verify the SHA-512 before you unpack anything.
2. Unpack only regular files. Ignore directories, and reject links, device
   files and other entry types.
3. Reject an entry whose path starts with `/`, or has a `..` part, or has a
   `\` or a drive letter.
4. Write only the entries that the package's `files` lists, and check each
   size against the index (the entry, or its `bytes`). Ignore all other
   entries (for example `tlpkg/`, and runfiles for other programs). In a TeX
   Live archive of a package that TeX Live does not relocate, the entries
   are below `texmf-dist/`: compare their paths without this prefix.
5. Write each file into the cache's `texmf-dist/` folder, at the path from
   `files`, never at a path from the archive.

### Change to a larger scope

The library has no fixed scope names. When the `files` of a `needs` result
are in no package of the current scope, the app:

1. Calls `findScope(files, candidates)`, with its scopes smallest first. The
   library loads the index files of each candidate only when it gets to it.
2. Shows a warning, and saves the new scope for the device.
3. Calls `setScope(scope)`. The worker makes a new engine in the new scope. It
   uses the index files that `findScope()` loaded, so it downloads and parses
   nothing again.
4. Compiles again. The result is then usually `needs` with packages.

A larger scope costs time at each compile: pdfTeX and kpathsea read a larger
`ls-R` and `pdftex.map` (about 100 ms more on a desktop for the full scope).

### Offline use

To prepare a device for offline use, download an offline archive
(`archives/<layer>.tar.xz`), verify it against the manifest, and unpack it
into the package cache with the safety rules. After that, documents in that
layer's scope do not need the network.

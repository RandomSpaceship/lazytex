# Tests and CI

`nix flake check` runs all tests. This page tells what each check examines,
and how GitHub Actions runs the checks and the release. The details are in
the docstrings and header comments of the files that this page links to.

## Run the checks

| Command | What it does |
|---|---|
| `nix flake check` | All four checks. |
| `nix build .#checks.x86_64-linux.CHECK` | One check, for example `node`. |
| `nix build .#checks.x86_64-linux.browser -L` | The browser check, with its log. The result has `report.json`. |

To run a check, Nix first builds all the parts that it uses: the engine, the
library, the index, the bundle trace and the bundle, the archives, the
`loads` records of the hosted packages, lazytex's release, and the release
and site of the example child. Thus a check that passes also tells you that
these parts build.

The checks use `.#release`, with the `loads` records of the hosted packages
only. The measurement of all packages (`.#release-full`) takes about
8 minutes on 16 threads, so CI builds it after the checks.

## The checks

The checks are in `checks.<system>` in [`flake.nix`](../flake.nix).

| Check | What it runs | Does it compile? |
|---|---|---|
| `release` | `checkRelease` on lazytex's release | No |
| `example-release` | `checkRelease` on the example child's release, with `parent` | No |
| `node` | `node --test tests/*.test.cjs` | Yes, in Node |
| `browser` | `tests/run_browser_test.py` in headless Chromium | Yes, in a worker |

### `release` and `example-release`

`checkRelease` ([`nix/lib.nix`](../nix/lib.nix)) runs
[`release/check_release.py`](../release/check_release.py), and then
[`release/pack_assets.py`](../release/pack_assets.py) into a temporary
folder. The docstring of `check_release.py` has the full list of its checks.
In short, it makes sure that:

- the index files and `manifest.json` match their JSON Schemas in `docs/`;
- the index files are one chain of layers, and their `depends` and `loads`
  entries agree;
- the manifest lists every file and source archive with the correct size and
  SHA-512;
- each release archive holds the indexed files of its package, at safe
  paths, and its URL names this release;
- each bundle is a plain ustar file with indexed files and `pdflatex.fmt`
  only;
- the library and the notices of the engine are in the release.

With `parent` (the example child), it also makes sure that the manifest
names the parent and the SHA-512 of its manifest, that no file is in two
bundles, and that the child changes no package entry of the parent. The
child can only add `releaseArchive` and `loads` entries. Child repos use the
same check ([`child-repos.md`](child-repos.md)).

### `node`

[`tests/default.nix`](../tests/default.nix) runs the Node tests on the site
of the example app. On this site, the full TeX tree is a stand-in for
installed packages, so the tests download nothing. The test documents come
from three folders: `tests/documents/`, `example/documents/` and
`bundle/documents/`.

| File | What it tests |
|---|---|
| [`resources.test.cjs`](../tests/resources.test.cjs) | Scopes, bundle layers, installs in rounds, the `needs` result, packages from the mirrors, log and error analysis, copied text, and the engine across repeated compiles. |
| [`scan.test.cjs`](../tests/scan.test.cjs) | The scan of the preamble. The scan and the log give the same packages and the same pages. |
| [`formats.test.cjs`](../tests/formats.test.cjs) | A format of the preamble (mylatexformat) gives the same page as a compile without it. |
| [`normalize.test.cjs`](../tests/normalize.test.cjs) | `normalizeSource()`, the normalizer of the cache keys. |

The tests compare pages as pixels (`pdftoppm`), not as PDF bytes.

### `browser`

[`tests/run_browser_test.py`](../tests/run_browser_test.py) serves the
example site, the library and the test page
([`tests/browser/`](../tests/browser/)), and opens the page in headless
Chromium. The page uses the real client and worker: start and progress,
compiles, the scan and `needs`, installs, errors, formats and their keys,
timeout and restart, stop, and a change of scope. The page sends each result
to the server. The check fails if one result fails, and writes all results
to `report.json`.

## CI

Three workflows in [`.github/workflows/`](../.github/workflows/):

```
push or pull request ──▶ check ──┬──▶ pages    (push to main)
                                 └──▶ release  (push of a tag v*)
```

### `check.yml`

It starts on each push and pull request.

1. Restore the Nix store of the last run from the GitHub Actions cache.
2. Run `nix flake check`.
3. Build `.#release-full` (the `loads` records of all packages).
4. Add GC roots for our own outputs and for each check.
5. Save the store to the cache.

Before the save, the cache action collects garbage down to 1 GB. The GC
roots keep our own outputs. The TeX trees and the toolchains (about 11 GB)
go, and the next run downloads them from cache.nixos.org again. A check
whose inputs did not change is in the cache, so the next run does not run it
again.

### `release.yml`

It starts after a successful check of a pushed tag that starts with `v`, or
by hand with a tag.

1. Make sure that the tag is a version tag, and that it names the commit
   that the check examined.
2. Restore the cache of the check, so that the job does not build the parts
   again.
3. Run `nix run .#release-assemble -- TAG out`. This runs `check_release.py`
   with `--assembled` on the full release.
4. Make a draft GitHub release, and upload the assets.

The command that publishes the draft (`gh release edit --draft=false`) is a
comment at this time, so the release stays a draft.

Release names and tags: [`formats.md`](formats.md), "Release names".

### `pages.yml`

It starts after a successful check of a push to `main`. It builds
`.#pages` (the demo site, with the medium tree only) and publishes it on
GitHub Pages.

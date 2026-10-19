"""Assemble the files of a release, with their manifest.

lazytex's own release and a child repo's release use this script. Writes into
--out (docs/formats.md describes each file):

  NOTICE.md                     the licences of the release's parts, and
                                where their source is
  manifest.json                 every file of the release with its size and
                                SHA-512, and the upstream versions. A child's
                                manifest also lists the files that it uses from
                                the parent release (marked "parent": true).
  busytex/busytex.js, busytex/busytex.wasm, busytex/NOTICE.md,
  busytex/licenses/
                                the engine, with its notice and licence
                                texts (--engine; lazytex only)
  js/client.js, js/worker.js, js/types/*.d.ts, js/LICENSE.md
                                the library, with lazytex's licence (--js;
                                lazytex only)
  <name>                        each bundle (--bundle NAME=DIR): bundle.tar
                                for lazytex, bundle-<app>.tar for a child
  index/index-<layer>.json      the index files (--index), with a
                                releaseArchive entry for each package that
                                this release hosts (a URL of a GitHub release
                                asset), and the measured loads records
                                (--loads)
  index/generated/<layer>/<tree>/<path>
                                the generated files of each scope
  archives/hosted/<package>.r<revision>.tar.xz, archives/<layer>.tar.xz
                                the package archives (--archives)

  python3 make_release.py --release TAG --repository OWNER/REPO --index INDEX \
      --archives ARCHIVES [--engine ENGINE --js JS] [--bundle NAME=DIR ...] \
      [--loads LOADS ...] [--parent PARENT_RELEASE] --out OUT

The release name is the git tag of the GitHub release. The URL of each
release archive is https://github.com/OWNER/REPO/releases/download/TAG/NAME,
where NAME is the archive's file name (GitHub release assets cannot be in
folders). The Nix build uses the tag "development", which is never
published. The release workflow runs this script again with the real tag
(the assemble app, release/default.nix).

A package entry that already has a releaseArchive (a child copies them from
lazytex's index) keeps it: the parent release hosts that package.
"""

import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

SAFE_NAME = re.compile(r"[A-Za-z0-9._-]+")
BUNDLE_NAME = re.compile(r"bundle(-[a-z0-9-]+)?\.tar")


def sha512_of(path):
    digest = hashlib.sha512()
    with open(path, "rb") as data:
        for chunk in iter(lambda: data.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


HISTORIC_ARCHIVE = "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/{year}/tlnet-final/archive/"


def notice(repository, release, texlive, parent_manifest):
    """NOTICE.md: the licences of the release's parts, and where their source is."""
    year = texlive["year"]
    engine_origin = "this release" if parent_manifest is None else \
        f"the release {parent_manifest['release']} of {parent_manifest['repository']}"
    return f"""# Licences and source

This is the release {release} of {repository}. It has these parts:

- **The engine** (`busytex/`, from {engine_origin}): pdfTeX, compiled to
  WebAssembly. It is under GPL-3.0-or-later. `busytex/NOTICE.md` lists its
  parts, their licences and their source.
- **The library** (`js/`, from {engine_origin}): lazytex's code, under the
  MIT licence (`js/LICENSE.md`).
- **The TeX files** (the bundles, `archives/` and the generated files in
  `index/generated/`): files of TeX Live {year} (revision {texlive["revision"]}).
  lazytex does not change them: an archive or a bundle holds files of a
  package with the same bytes as TeX Live's own archives, and the generated
  files come from these files. An archive holds all runfiles of its
  package, and a bundle only the files that its documents read.
  Each file is under the licence of its TeX Live package. The
  `catalogue-license` of the package in TeX Live's `texlive.tlpdb` gives
  that licence, and the package's page on CTAN (https://ctan.org/pkg/<name>)
  gives more. TeX Live's historic archive of TeX Live {year} has the source
  and the documentation (with the licence text) of each package:

  {HISTORIC_ARCHIVE.format(year=year)}<name>.source.tar.xz
  {HISTORIC_ARCHIVE.format(year=year)}<name>.doc.tar.xz

  https://tug.org/historic/ lists other copies of this archive.
- **The index files and the manifest** (`index/*.json`, `manifest.json`):
  made by lazytex's tools from TeX Live's package database.
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", required=True, help="the release name: the git tag, for example v1.0.0")
    parser.add_argument("--repository", required=True, help="the GitHub repository of the release, OWNER/REPO")
    parser.add_argument("--index", required=True, help="a directory with index-*.json and generated/")
    parser.add_argument("--archives", required=True, help="the output of make_archives.py")
    parser.add_argument("--engine", help="the engine build (busytex.js, busytex.wasm, engine.json)")
    parser.add_argument("--js", help="the library build (client.js, worker.js, types/)")
    parser.add_argument("--bundle", action="append", default=[], help="NAME=DIR: DIR/bundle.tar becomes NAME in the release")
    parser.add_argument("--loads", action="append", default=[], help="the output of measure_loads.cjs (loads.json)")
    parser.add_argument("--parent", help="the parent release (a directory with its manifest.json)")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.release):
        raise SystemExit(f"not a safe tag for a URL: {args.release!r}")
    if not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", args.repository):
        raise SystemExit(f"not OWNER/REPO: {args.repository!r}")
    if bool(args.engine) == bool(args.parent) or bool(args.js) == bool(args.parent):
        raise SystemExit("give --engine and --js (lazytex's release), or --parent (a child release)")
    asset_base_url = f"https://github.com/{args.repository}/releases/download/{args.release}/"
    index_dir, archives_dir, out = Path(args.index), Path(args.archives), Path(args.out)

    if args.engine:
        for name in ("busytex.js", "busytex.wasm", "NOTICE.md"):
            copy(Path(args.engine) / name, out / "busytex" / name)
        shutil.copytree(Path(args.engine) / "licenses", out / "busytex" / "licenses")
    if args.js:
        js_dir = Path(args.js)
        # The library for apps. core.cjs is for Node tools only.
        for name in ("client.js", "worker.js", "LICENSE.md"):
            copy(js_dir / name, out / "js" / name)
        for declaration in sorted((js_dir / "types").glob("*.d.ts")):
            copy(declaration, out / "js" / "types" / declaration.name)
    for value in args.bundle:
        name, _, directory = value.partition("=")
        if not BUNDLE_NAME.fullmatch(name):
            raise SystemExit(f"a bundle's name is bundle.tar or bundle-<name>.tar, not {name!r}")
        copy(Path(directory) / "bundle.tar", out / name)
    shutil.copytree(index_dir / "generated", out / "index" / "generated")

    archives = json.loads((archives_dir / "archives.json").read_text())
    all_archives = [*archives["hosted"].values(), *archives["offline"].values()]
    asset_names = [Path(archive["file"]).name for archive in all_archives]
    if len(set(asset_names)) != len(asset_names):
        raise SystemExit("two release archives have the same file name, so they would have the same asset name")
    # GitHub changes other characters in asset names, and the URL would not match.
    unsafe = [name for name in asset_names if not SAFE_NAME.fullmatch(name)]
    if unsafe:
        raise SystemExit(f"archive file names that are not safe asset names: {unsafe}")
    for archive in all_archives:
        copy(archives_dir / archive["file"], out / "archives" / archive["file"])

    # The index files, with a releaseArchive entry for each package that this
    # release hosts, and the loads records of each measured package.
    loads = {}
    for loads_dir in args.loads:
        loads.update(json.loads((Path(loads_dir) / "loads.json").read_text()))
    texlive = None
    for index_path in sorted(index_dir.glob("index-*.json")):
        index = json.loads(index_path.read_text())
        texlive = index["texlive"]
        for name, package in index["packages"].items():
            archive = archives["hosted"].get(name)
            record = loads.get(name)
            files = package.pop("files")
            if record and "loads" not in package:
                package["loads"] = record["loads"]
                for relative_path, file_loads in record["files"].items():
                    files[relative_path] = {"bytes": files[relative_path], "loads": file_loads}
            if archive:
                if "releaseArchive" in package:
                    raise SystemExit(f"{name}: the parent release hosts it already")
                package["releaseArchive"] = {"url": asset_base_url + Path(archive["file"]).name,
                                             "bytes": archive["bytes"], "sha512": archive["sha512"]}
            package["files"] = files
        (out / "index" / index_path.name).write_text(json.dumps(index, separators=(",", ":")))

    parent_manifest = json.loads((Path(args.parent) / "manifest.json").read_text()) if args.parent else None
    (out / "NOTICE.md").write_text(notice(args.repository, args.release, texlive, parent_manifest))

    manifest = {
        "format": "lazytex-release",
        "version": 1,
        "release": args.release,
        "repository": args.repository,
        "upstream": None,
        "files": {},
    }
    if args.engine:
        engine_info = json.loads((Path(args.engine) / "engine.json").read_text())
        manifest["upstream"] = {
            "busytex": engine_info["busytex"],
            "texliveSource": engine_info["texliveSource"],
            "emscripten": engine_info["emscripten"],
            "texliveData": texlive,
        }
    for path in sorted(item for item in out.rglob("*") if item.is_file()):
        relative_path = path.relative_to(out).as_posix()
        manifest["files"][relative_path] = {"bytes": path.stat().st_size, "sha512": sha512_of(path)}
    if args.parent:
        # The files that an app needs from the parent release: the engine,
        # the library and the parent's bundles. The app downloads them from
        # the parent release, and serves them next to this release's files.
        parent_dir = Path(args.parent)
        manifest["upstream"] = parent_manifest["upstream"]
        manifest["parent"] = {"repository": parent_manifest["repository"], "release": parent_manifest["release"],
                              "manifestSha512": sha512_of(parent_dir / "manifest.json")}
        for relative_path, entry in parent_manifest["files"].items():
            if relative_path.startswith(("busytex/", "js/")) or BUNDLE_NAME.fullmatch(relative_path):
                if relative_path in manifest["files"]:
                    raise SystemExit(f"{relative_path} is in this release and in the parent release")
                manifest["files"][relative_path] = {"bytes": entry["bytes"], "sha512": entry["sha512"], "parent": True}
        manifest["files"] = dict(sorted(manifest["files"].items()))
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()

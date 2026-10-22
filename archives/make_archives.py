"""Pack the TeX package archives that a release publishes.

  hosted/<package>.r<revision>.tar.xz
                one archive for each hosted package: the packages of --hosted
                with their dependencies, and every package that has a file in
                the bundle (on a miss, the app downloads the whole package, so
                these are the likely ones). A package whose index entry
                already has a releaseArchive is left out: a parent release
                (lazytex's) hosts it.
  <layer>.tar.xz
                with --offline LAYER: all runfiles of the packages of
                index-<layer>.json, in one archive, for offline use
  archives.json each archive with its SHA-512, size and file count. The
                release step (release/make_release.py) copies these values
                into the index (releaseArchive) and into the release
                manifest. This file is not part of the release.

Each archive holds all runfiles of its package (its "runfiles" in
texlive.tlpdb), at their paths relative to texmf-dist (for example
"tex/latex/pgfplots/..."), as in TeX Live's own archives, so one unpack step
serves both. The index lists only the files that pdfTeX can read, so an
archive also has files that the index does not list (for example the
makeindex, dvips or ConTeXt files of a package), and an app writes only the
indexed files. An archive has no documentation or source files, as TeX
Live's runfile archives, and no runfiles of TeX Live's installer and tlmgr
(in tlpkg/ and at the root of TeX Live). With all runfiles, an archive is a complete,
unchanged copy of the package's installed files: a compiled work in the
terms of the LPPL (docs/design.md, "Licences").

The archives are repacks of nixpkgs' unpacked packages, so they are not
byte-identical to TeX Live's archives. The files in them have the same bytes
as TeX Live's (tools/check_mirror_download.py compares them). Their own
SHA-512 values (in the index and the release manifest) verify the archives.
The output is reproducible: sorted entries, fixed time stamps and owners,
and xz with a fixed block size.

  python3 make_archives.py --index INDEX_DIR --scope index-full.json --tlpdb TLPDB \
      --hosted HOSTED.json [--bundle-stats STATS ...] [--offline LAYER ...] --tree FULL_TREE --out OUT
"""

import argparse
import hashlib
import json
import subprocess
import sys
import tarfile
from collections import defaultdict
from pathlib import Path

# make_index.py reads texlive.tlpdb (index/, on PYTHONPATH in Nix builds).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "index"))
from make_index import dependency_closure, read_tlpdb  # noqa: E402

XZ = ["xz", "--format=xz", "-9", "--threads=8", "--block-size=16MiB", "--check=crc64", "--stdout"]


def write_tar(relative_paths, tree, handle):
    """A tar of the files, in path order, with fixed metadata."""
    with tarfile.open(fileobj=handle, mode="w|", format=tarfile.PAX_FORMAT) as archive:
        for relative_path in sorted(relative_paths):
            source = tree / relative_path
            info = tarfile.TarInfo(relative_path)
            info.size = source.stat().st_size
            info.mtime = 0
            info.mode = 0o644
            with open(source, "rb") as data:
                archive.addfile(info, data)


def write_archive(path, relative_paths, tree):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as output:
        compressor = subprocess.Popen(XZ, stdin=subprocess.PIPE, stdout=output)
        write_tar(relative_paths, tree, compressor.stdin)
        compressor.stdin.close()
        if compressor.wait() != 0:
            raise SystemExit(f"xz failed for {path}")
    digest = hashlib.sha512()
    with open(path, "rb") as data:
        for chunk in iter(lambda: data.read(1 << 20), b""):
            digest.update(chunk)
    return {"sha512": digest.hexdigest(), "bytes": path.stat().st_size, "files": len(relative_paths),
            "fileBytes": sum((tree / relative_path).stat().st_size for relative_path in relative_paths)}


def runfiles_of(name, packages, indexed_paths, tree):
    """All runfiles of a package in texmf-dist, relative to it. Each indexed
    file is one of them, and the tree has each of them. Runfiles outside
    texmf-dist are files of TeX Live's installer and tlmgr: in tlpkg/ (for
    example dvipdfmx's tlpkg/tlpostcode/dvipdfmx.pl), or at the root of TeX
    Live (install-tl, and texlive.infra's LICENSE.TL, LICENSE.CTAN and
    release-texlive.txt). TeX never reads them, so an archive does not hold
    them. An LPPL package must not have them: its archive is a compiled work
    only with all its runfiles (docs/design.md, "Licences")."""
    runfiles = []
    for path in packages[name]["runfiles"]:
        if not path.startswith("texmf-dist/"):
            if not (path.startswith("tlpkg/") or "/" not in path):
                raise SystemExit(f"{name}: the runfile {path} is not in texmf-dist, tlpkg or the root of TeX Live")
            if any(licence.startswith("lppl") for licence in packages[name]["licences"]):
                raise SystemExit(f"{name}: an LPPL package with the runfile {path}, which an archive cannot hold")
            continue
        runfiles.append(path[len("texmf-dist/"):])
    not_runfiles = sorted(set(indexed_paths) - set(runfiles))
    if not_runfiles:
        raise SystemExit(f"{name}: indexed files that are not runfiles in texlive.tlpdb: {not_runfiles[:5]}")
    missing = sorted(path for path in runfiles if not (tree / path).is_file())
    if missing:
        raise SystemExit(f"{name}: runfiles that the tree does not have: {missing[:5]}")
    return runfiles


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", required=True, help="the directory of the index files")
    parser.add_argument("--scope", required=True, help="the index files of the scope in INDEX_DIR, separated by commas")
    parser.add_argument("--tlpdb", required=True, help="texlive.tlpdb.xz, for the dependencies and the runfiles")
    parser.add_argument("--hosted", required=True, help="a JSON list of package names to host")
    parser.add_argument("--bundle-stats", action="append", default=[], help="stats.json of a bundle: host its packages")
    parser.add_argument("--offline", action="append", default=[], help="a layer to pack as one archive for offline use")
    parser.add_argument("--tree", required=True, help="share/texmf of a tree with every package of the scope")
    parser.add_argument("--max-bundle-package-bytes", type=int, default=20_000_000,
                        help="fail for a package that only a bundle brings in, if TeX Live's archive of it is larger")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    tree, out = Path(args.tree), Path(args.out)
    index_dir = Path(args.index)
    scope_packages = {}
    for file_name in args.scope.split(","):
        index = json.loads((index_dir / file_name).read_text())
        scope_packages[index["scope"]] = index["packages"]

    packages, _ = read_tlpdb(args.tlpdb)
    listed = dependency_closure(json.loads(Path(args.hosted).read_text()), packages)
    bundle_packages = {name for stats in args.bundle_stats for name in json.loads(Path(stats).read_text())["packages"]}
    # One file in a bundle makes its whole package a hosted archive. A large
    # one is usually a mistake in a bundle document (for example one TS1
    # glyph brings in cm-super, 65 MB). List a large package in --hosted if it
    # is wanted.
    all_packages = {name: package for entries in scope_packages.values() for name, package in entries.items()}
    too_large = sorted(name for name in bundle_packages - listed
                       if name in all_packages and all_packages[name]["archiveBytes"] > args.max_bundle_package_bytes)
    if too_large:
        raise SystemExit(f"bundle packages larger than {args.max_bundle_package_bytes} bytes: {too_large}. "
                         "Change the bundle documents, or list the packages in --hosted.")
    # Check the runfiles of every package of the scope, not only of the
    # packages that this build packs: a package that a later build hosts, or
    # an offline layer of a child, must not fail first there.
    for entries in scope_packages.values():
        for name, package in entries.items():
            runfiles_of(name, packages, package["files"], tree)
    archives = {"hosted": {}, "offline": {}}
    for scope, entries in scope_packages.items():
        for name, package in entries.items():
            if (name in listed or name in bundle_packages) and "releaseArchive" not in package:
                file_name = f"hosted/{name}.r{package['revision']}.tar.xz"
                runfiles = runfiles_of(name, packages, package["files"], tree)
                archives["hosted"][name] = dict(write_archive(out / file_name, runfiles, tree),
                                                file=file_name, scope=scope, listed=name in listed,
                                                inBundle=name in bundle_packages)

    for layer in args.offline:
        if layer not in scope_packages:
            raise SystemExit(f"--offline {layer}: no index file of the scope has that layer")
        paths = [relative_path for name, package in scope_packages[layer].items()
                 for relative_path in runfiles_of(name, packages, package["files"], tree)]
        archives["offline"][layer] = dict(write_archive(out / f"{layer}.tar.xz", paths, tree),
                                          file=f"{layer}.tar.xz", packages=len(scope_packages[layer]))
    # A child can have no archives of its own.
    out.mkdir(parents=True, exist_ok=True)
    (out / "archives.json").write_text(json.dumps(archives, indent=2))


if __name__ == "__main__":
    main()

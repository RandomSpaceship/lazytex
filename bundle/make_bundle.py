"""Pack a preloaded bundle from the trace of trace_bundle.cjs.

The bundle holds every package file that the traced runs read, and
pdflatex.fmt (lazytex's bundle; a child's bundle uses --without-format). The
run that builds pdflatex.fmt is not used: the bundle ships that format, so
the device never reads its inputs (mostly hyphenation patterns). It holds no
generated file (ls-R, texmf-var): those differ between the scopes, and come
with the index. A child's bundle leaves out each file of the bundles under it
(--exclude-bundle), so that no two bundles have the same file. Writes into
--out:

  bundle.tar    the files, as an uncompressed tar (ustar format). Each entry
                is at its path in the engine's file system, without the
                leading "/". The engine reads it with readTarBundle() and
                keeps each file as a view into the tar, so nothing is copied.
  stats.json    sizes, the packages of the bundle, and what each traced run
                still loads lazily

The tar is reproducible: entries in path order, with fixed time stamps,
owners and modes.

  python3 make_bundle.py --site SITE --scope index/index-full.json --trace TRACE \
      [--exclude-bundle TAR ...] [--without-format] --out OUT
"""

import argparse
import gzip
import json
import tarfile
from pathlib import Path

# The engine reads formats from here (FORMAT_DIRECTORY in library/src/engine.ts).
FORMAT_PATH = "/home/web_user/fmt/pdflatex.fmt"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", required=True, help="has the index files of the scope and texlive/texmf-dist")
    parser.add_argument("--scope", required=True, help="the index files of the scope below SITE, separated by commas")
    parser.add_argument("--trace", required=True, help="output of trace_bundle.cjs")
    parser.add_argument("--exclude-bundle", action="append", default=[], help="a bundle under this one: leave out its files")
    parser.add_argument("--without-format", action="store_true", help="leave out pdflatex.fmt (a bundle under this one has it)")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    site, trace, out = Path(args.site), Path(args.trace), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    indexes = [json.loads((site / index_path).read_text()) for index_path in args.scope.split(",")]
    trees = indexes[0]["trees"]
    dist_mount = trees["texmf-dist"]
    package_of_path = {f"{dist_mount}/{relative_path}": name for index in indexes
                       for name, package in index["packages"].items() for relative_path in package["files"]}
    generated = indexes[-1]["generated"]
    generated_paths = {f"{trees[tree]}/{relative_path}" for tree, entries in generated.items() for relative_path in entries}
    excluded = set()
    for bundle_path in args.exclude_bundle:
        with tarfile.open(bundle_path) as bundle:
            excluded.update("/" + name for name in bundle.getnames())
    files_read = json.loads((trace / "files-read.json").read_text())
    runs = {run: paths for run, paths in files_read.items() if run != "format:pdflatex"}

    read_paths = sorted({path for paths in runs.values() for path in paths})
    unknown = [path for path in read_paths if path not in package_of_path and path not in generated_paths]
    if unknown:
        raise SystemExit(f"files read but not in the index: {unknown[:5]}")
    entries = [(path, site / path.lstrip("/")) for path in read_paths if path in package_of_path and path not in excluded]
    if not args.without_format:
        entries.append((FORMAT_PATH, trace / "fmt" / "pdflatex.fmt"))

    with tarfile.open(out / "bundle.tar", "w", format=tarfile.USTAR_FORMAT) as archive:
        for path, source in sorted(entries):
            info = tarfile.TarInfo(path.lstrip("/"))
            info.size = source.stat().st_size
            info.mtime = 0
            info.mode = 0o644
            with open(source, "rb") as handle:
                archive.addfile(info, handle)

    tar_bytes = (out / "bundle.tar").read_bytes()
    generated_sizes = {f"{trees[tree]}/{relative_path}": size
                       for tree, sizes in generated.items() for relative_path, size in sizes.items()}
    stats = {
        "files": len(entries),
        "fileBytes": sum(source.stat().st_size for _, source in entries),
        "tarBytes": len(tar_bytes),
        "gzipBytes": len(gzip.compress(tar_bytes, compresslevel=6)),
        "formatBytes": 0 if args.without_format else (trace / "fmt" / "pdflatex.fmt").stat().st_size,
        "excludedFiles": len([path for path in read_paths if path in excluded]),
        "packages": sorted({package_of_path[path] for path, _ in entries if path in package_of_path}),
        # What each traced run loads lazily with this bundle and the bundles
        # under it: generated files only.
        "lazyWithBundle": {
            run: {"files": len([path for path in paths if path not in package_of_path]),
                  "bytes": sum(generated_sizes.get(path, 0) for path in paths if path not in package_of_path)}
            for run, paths in runs.items()
        },
    }
    (out / "stats.json").write_text(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()

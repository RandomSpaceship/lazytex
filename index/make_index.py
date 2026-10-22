"""Write lazytex's file index: one index file of the full scope.

Reads the TeX Live package database (texlive.tlpdb.xz) and the TeX tree of
the full scope, and writes into --out:

  index-full.json  every package that the engine can read (format:
                   docs/formats.md, schema: docs/index.schema.json). Each
                   package has its revision, archive size and SHA-512 (from
                   texlive.tlpdb), its direct dependencies, and its files with
                   their sizes. The release step (release/make_release.py)
                   adds the releaseArchive entries and the loads records.
  generated/full/<tree>/<path>
                   files that are in no TeX Live package and depend on the set
                   of packages: kpathsea's file lists (ls-R), and the
                   texmf-var files that pdfTeX reads (pdftex.map,
                   language.dat). The list is "generatedFiles" in
                   package-sets.json.
  stats.json       counts and sizes

A child repo makes its own scopes from index-full.json with narrow_index.py.

  python3 make_index.py --tlpdb texlive.tlpdb.xz --package-sets package-sets.json \
      --tree TREE --out OUT
"""

import argparse
import gzip
import json
import lzma
import os
import re
from collections import defaultdict
from pathlib import Path

# Mount points in the engine's file system.
DIST_MOUNT = "/texlive/texmf-dist"
VAR_MOUNT = "/texlive/texmf-var"
# Top-level directories that pdfTeX and kpathsea read. Docs, sources and
# scripts are not included.
INCLUDE_TOP = {"tex", "fonts", "web2c"}
# Formats made by the native engines: the wasm engine can only load formats
# that it made itself, so kpathsea must not find these.
EXCLUDE_SUFFIX = (".fmt", ".base", ".mem", ".log")
# updmap writes the paths of its inputs into comments of pdftex.map. In a Nix
# build these are store paths: they would make the release depend on the
# whole TeX tree, and they mean nothing on a device.
STORE_PATH = re.compile(rb"/nix/store/[0-9a-z]{32}-[^/\s]*")


def read_tlpdb(path):
    """Return {name: package} from texlive.tlpdb.xz, and the values of the
    00texlive.config entry ("release", "frozen", "revision", ...)."""
    packages = {}
    current = None
    section = None
    with lzma.open(path, "rt", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not line:
                current = None
                section = None
                continue
            if line.startswith("name "):
                current = {"name": line[5:], "revision": 0, "category": "", "containerBytes": 0,
                           "sha512": "", "depends": [], "runfiles": [], "licences": []}
                packages[current["name"]] = current
                section = None
            elif current is None:
                continue
            elif line.startswith(" "):
                if section == "run":
                    # Paths are "RELOC/..." for files under texmf-dist.
                    current["runfiles"].append(line.strip().split(" ")[0].replace("RELOC/", "texmf-dist/", 1))
            else:
                key, _, value = line.partition(" ")
                section = "run" if key == "runfiles" else None
                if key == "revision":
                    current["revision"] = int(value)
                elif key == "category":
                    current["category"] = value
                elif key == "containersize":
                    current["containerBytes"] = int(value)
                elif key == "containerchecksum":
                    current["sha512"] = value
                elif key == "depend":
                    current["depends"].append(value)
                elif key == "catalogue-license":
                    # For example "lppl1.3c gpl2".
                    current["licences"] = value.split()
    config_entry = packages.pop("00texlive.config")
    config = dict(value.split("/", 1) for value in config_entry["depends"] if "/" in value)
    config.setdefault("revision", str(config_entry["revision"]))
    return packages, config


def walk(tree, exclude_paths):
    """Yield (relative path, size) for every regular file under tree."""
    for top_directory in sorted(os.listdir(tree)):
        if top_directory not in INCLUDE_TOP:
            continue
        for directory, directory_names, file_names in os.walk(os.path.join(tree, top_directory), followlinks=True):
            relative_directory = os.path.relpath(directory, tree)
            directory_names[:] = sorted(
                name for name in directory_names
                if not any(f"{relative_directory}/{name}" == excluded or f"{relative_directory}/{name}".startswith(excluded + "/")
                           for excluded in exclude_paths))
            for name in sorted(file_names):
                full_path = os.path.join(directory, name)
                if os.path.isfile(full_path) and not name.endswith(EXCLUDE_SUFFIX):
                    yield os.path.relpath(full_path, tree), os.path.getsize(full_path)


def write_ls_r(path, relative_paths):
    """kpathsea's ls-R: a listing of each directory, as `ls -R` prints it."""
    directories = defaultdict(set)
    for relative_path in relative_paths:
        parts = relative_path.split("/")
        for i in range(len(parts)):
            directories["/".join(parts[:i])].add(parts[i])
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as handle:
        handle.write("% ls-R -- filename database for kpathsea; do not change this line.\n")
        for directory in sorted(directories):
            handle.write(f"./{directory}:\n" if directory else "./:\n")
            for entry in sorted(directories[directory]):
                handle.write(entry + "\n")
            handle.write("\n")
    return path.stat().st_size, len(directories)


def dependency_closure(names, packages):
    """The packages in names and everything they depend on (not collections)."""
    result = set()
    pending = list(names)
    while pending:
        name = pending.pop()
        if name in result or name not in packages:
            continue
        result.add(name)
        pending.extend(dependency for dependency in packages[name]["depends"] if not dependency.startswith("collection-"))
    return result


def write_generated(generated_root, var_tree, generated_files, dist_paths):
    """The generated files of a scope: the texmf-var files that pdfTeX reads,
    and an ls-R for each tree. Returns the index's "generated" entry."""
    var_files = {}
    for relative_path in sorted(generated_files):
        target = generated_root / "texmf-var" / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(STORE_PATH.sub(b"<tree>", (Path(var_tree) / relative_path).read_bytes()))
        var_files[relative_path] = target.stat().st_size
    dist_ls_r_bytes, _ = write_ls_r(generated_root / "texmf-dist" / "ls-R", dist_paths)
    var_ls_r_bytes, _ = write_ls_r(generated_root / "texmf-var" / "ls-R", list(var_files))
    var_files["ls-R"] = var_ls_r_bytes
    return {"texmf-dist": {"ls-R": dist_ls_r_bytes}, "texmf-var": dict(sorted(var_files.items()))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tlpdb", required=True)
    parser.add_argument("--package-sets", required=True)
    parser.add_argument("--tree", required=True, help="the TeX tree of the full scope (has share/texmf and share/texmf-var)")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    package_sets = json.loads(Path(args.package_sets).read_text())

    packages, config = read_tlpdb(args.tlpdb)
    file_to_package = {}
    for package in packages.values():
        for runfile in package["runfiles"]:
            file_to_package[runfile] = package["name"]

    tree_files = dict(walk(os.path.join(args.tree, "share", "texmf"), package_sets["excludePaths"]))
    problems = []
    unmapped = []
    files_of_package = defaultdict(dict)
    for relative_path, size in tree_files.items():
        package_name = file_to_package.get("texmf-dist/" + relative_path)
        if package_name is None:
            unmapped.append(relative_path)
        else:
            files_of_package[package_name][relative_path] = size
    if unmapped:
        # Files that are in the tree but in no TeX Live package. The index
        # cannot say where to download them from.
        problems.append(f"{len(unmapped)} files are in no TeX Live package, for example {unmapped[:5]}")
    if problems:
        raise SystemExit("\n".join(problems[:20]))

    index_packages = {}
    for name in sorted(files_of_package):
        package = packages[name]
        entry = {
            "revision": package["revision"],
            "archiveBytes": package["containerBytes"],
            "sha512": package["sha512"],
            "files": dict(sorted(files_of_package[name].items())),
        }
        # Direct dependencies that the index has. Collections and packages
        # without engine files (for example binaries) are left out.
        depends = sorted({dependency for dependency in package["depends"] if dependency in files_of_package and dependency != name})
        if depends:
            entry["depends"] = depends
        index_packages[name] = entry

    generated = write_generated(out / "generated" / "full", os.path.join(args.tree, "share", "texmf-var"),
                                package_sets["generatedFiles"], sorted(tree_files))
    index = {
        "format": "lazytex-index",
        "version": 1,
        "scope": "full",
        "texlive": {"year": int(config["release"]), "revision": int(config["revision"]), "frozen": config.get("frozen") == "1"},
        "trees": {"texmf-dist": DIST_MOUNT, "texmf-var": VAR_MOUNT},
        "packages": index_packages,
        "generated": generated,
    }
    index_text = json.dumps(index, separators=(",", ":")).encode()
    (out / "index-full.json").write_bytes(index_text)
    ls_r = (out / "generated" / "full" / "texmf-dist" / "ls-R").read_bytes()
    stats = {
        "texlive": config,
        "files": len(tree_files),
        "bytes": sum(tree_files.values()),
        "packages": len(index_packages),
        "archiveBytes": sum(package["archiveBytes"] for package in index_packages.values()),
        "lsRBytes": len(ls_r),
        "lsRGzipBytes": len(gzip.compress(ls_r, compresslevel=9)),
        "indexBytes": len(index_text),
        "indexGzipBytes": len(gzip.compress(index_text, compresslevel=9)),
        "largestArchives": sorted(([name, package["archiveBytes"]] for name, package in index_packages.items()), key=lambda row: -row[1])[:15],
    }
    (out / "stats.json").write_text(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()

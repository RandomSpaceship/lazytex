"""Make a child repo's scopes from lazytex's full index (index-full.json).

A child repo (for example an app's own resources) uses smaller scopes than
lazytex's full scope, so that the engine starts with a smaller index. Each
scope is a layer of index files: a layer holds only the packages that the
layers under it do not have. This tool narrows the full index into layers:

  --layer NAME=TREE   a layer with the packages of TREE (a TeX tree that
                      texlive.treeOf of lazytex made, so from the same TeX
                      Live), without the packages of the layers under it.
                      Give the layers from the lowest up. Each TREE must hold
                      the tree under it.
  --rest NAME         optional: a last layer with all other packages of the
                      full index. The layers up to it then have the same
                      packages as the full scope.

It writes into --out:

  index-<NAME>.json   one index file for each layer. The lowest has "trees";
                      each other one has "extends": the layer under it. Each
                      package entry is the entry of index-full.json without
                      change (with its releaseArchive and loads, if the full
                      index has them).
  generated/<NAME>/<tree>/<path>
                      the generated files of the scope that ends at this
                      layer: ls-R from the files of the scope, and pdftex.map
                      and language.dat from the layer's TREE. The rest layer
                      has the same packages as the full scope, so it gets the
                      generated files of index-full.json without change.

Each file of a TREE must be in the full index with the same size, and each
package must be complete in its layer.

  python3 narrow_index.py --full INDEX_DIR --package-sets package-sets.json \
      --layer medium=TREE [--layer ...] [--rest full-extra] --out OUT

INDEX_DIR has index-full.json and generated/full/ (lazytex's index/ of a
release, or the output of lazytex's index build).
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_index import walk, write_generated  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--full", required=True, help="directory with index-full.json and generated/full/")
    parser.add_argument("--package-sets", required=True, help="lazytex's package-sets.json (excludePaths, generatedFiles)")
    parser.add_argument("--layer", action="append", required=True, help="NAME=TREE, from the lowest layer up")
    parser.add_argument("--rest", help="the name of a last layer with all other packages")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    full_dir, out = Path(args.full), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    package_sets = json.loads(Path(args.package_sets).read_text())
    full = json.loads((full_dir / "index-full.json").read_text())
    if full.get("scope") != "full" or "extends" in full:
        raise SystemExit("--full must have lazytex's index-full.json")
    layers = [value.split("=", 1) for value in args.layer]
    names = [name for name, _ in layers] + ([args.rest] if args.rest else [])
    if len(set(names)) != len(names) or "full" in names:
        raise SystemExit(f"layer names must be different, and not 'full': {names}")

    owner_of = {}
    for package_name, package in full["packages"].items():
        for relative_path, entry in package["files"].items():
            owner_of[relative_path] = (package_name, entry if isinstance(entry, int) else entry["bytes"])

    problems = []
    taken = set()
    previous_files = set()
    previous_name = None
    for name, tree in layers:
        tree_files = dict(walk(os.path.join(tree, "share", "texmf"), package_sets["excludePaths"]))
        missing_below = previous_files - set(tree_files)
        if missing_below:
            problems.append(f"{name}: the tree does not have files of the layers under it, for example {sorted(missing_below)[:3]}")
        layer_packages = set()
        for relative_path, size in tree_files.items():
            owner = owner_of.get(relative_path)
            if owner is None:
                problems.append(f"{name}: {relative_path} is not in the full index")
            elif owner[1] != size:
                problems.append(f"{name}: {relative_path} has another size in the full index")
            else:
                layer_packages.add(owner[0])
        for package_name in sorted(layer_packages):
            absent = [path for path in full["packages"][package_name]["files"] if path not in tree_files]
            if absent:
                problems.append(f"{name}: package {package_name} is only partly in the tree, for example {absent[:3]}")
        layer_packages -= taken
        known = taken | layer_packages
        for package_name in sorted(layer_packages):
            outside = [dependency for dependency in full["packages"][package_name].get("depends", []) if dependency not in known]
            if outside:
                problems.append(f"{name}: package {package_name} depends on {outside}, which the scope does not have")
        if problems:
            break
        index = {
            "format": "lazytex-index",
            "version": 1,
            "scope": name,
            **({"extends": previous_name} if previous_name else {}),
            "texlive": full["texlive"],
            **({} if previous_name else {"trees": full["trees"]}),
            "packages": {package_name: full["packages"][package_name] for package_name in sorted(layer_packages)},
            "generated": write_generated(out / "generated" / name, os.path.join(tree, "share", "texmf-var"),
                                         package_sets["generatedFiles"], sorted(tree_files)),
        }
        (out / f"index-{name}.json").write_text(json.dumps(index, separators=(",", ":")))
        taken |= layer_packages
        previous_files = set(tree_files)
        previous_name = name
    if problems:
        raise SystemExit("\n".join(problems[:20]))

    if args.rest:
        rest = {
            "format": "lazytex-index",
            "version": 1,
            "scope": args.rest,
            "extends": previous_name,
            "texlive": full["texlive"],
            "packages": {package_name: package for package_name, package in full["packages"].items() if package_name not in taken},
            "generated": full["generated"],
        }
        (out / f"index-{args.rest}.json").write_text(json.dumps(rest, separators=(",", ":")))
        shutil.copytree(full_dir / "generated" / "full", out / "generated" / args.rest)


if __name__ == "__main__":
    main()

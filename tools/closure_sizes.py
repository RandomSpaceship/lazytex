"""Show what candidate packages would add to the hosted packages of a release.

For each candidate: its dependency closure (TeX Live's `depends`), and the
size of the TeX Live archives of the packages that the closure adds to the
packages that the release hosts now. quartz-resources'
docs/plans/hosted-packages.md has the results of 2026-10-19.

Usage (from the repo root):
  nix build .#index -o .scratch/index
  nix build .#archives -o .scratch/archives
  python3 -I tools/closure_sizes.py --index .scratch/index \
      --archives .scratch/archives geometry hyperref lm …

Without --archives, it compares with the "hosted" list of
texlive/package-sets.json and its closure (the bundle's packages are then
not included).
"""
import argparse
import json
from pathlib import Path


def read_packages(index_dir):
    packages = {}
    for index_path in sorted(index_dir.glob("index-*.json")):
        index = json.loads(index_path.read_text())
        packages.update(index["packages"])
    return packages


def closure(names, packages):
    seen = set()
    stack = list(names)
    while stack:
        name = stack.pop()
        if name in seen or name not in packages:
            continue
        seen.add(name)
        stack.extend(packages[name].get("depends", []))
    return seen


def megabytes(names, packages):
    return f"{sum(packages[name]['archiveBytes'] for name in names) / 1e6:.2f}"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", required=True, help="an index folder: the output of nix build .#index, or index/ of a release")
    parser.add_argument("--archives", help="output of nix build .#archives (the packages hosted now)")
    parser.add_argument("--package-sets", default="texlive/package-sets.json")
    parser.add_argument("candidates", nargs="+")
    args = parser.parse_args()
    packages = read_packages(Path(args.index))

    if args.archives:
        hosted = set(json.loads((Path(args.archives) / "archives.json").read_text())["hosted"])
    else:
        hosted = closure(json.loads(Path(args.package_sets).read_text())["hosted"], packages)

    missing = [name for name in args.candidates if name not in packages]
    if missing:
        print("Not in the index:", ", ".join(missing))
    print("| Package | Own archive (MB) | Closure packages | Closure archives (MB) | Adds to hosted (MB) |")
    print("|---|---|---|---|---|")
    for name in args.candidates:
        if name not in packages:
            continue
        package_closure = closure([name], packages)
        print(f"| `{name}` | {megabytes([name], packages)} | {len(package_closure)} | "
              f"{megabytes(package_closure, packages)} | {megabytes(package_closure - hosted, packages)} |")

    total = closure(args.candidates, packages) | hosted
    print()
    print(f"Hosted now: {len(hosted)} packages, {megabytes(hosted, packages)} MB")
    print(f"With the candidates: {len(total)} packages, {megabytes(total, packages)} MB "
          f"(adds {megabytes(total - hosted, packages)} MB)")


if __name__ == "__main__":
    main()

# /// script
# requires-python = ">=3.13"
# dependencies = ["jsonschema"]
# ///

"""Check the files of a release (lazytex's or a child's): the formats, and that
the files agree with each other. lazytex's flake check runs it on its own
release; a child runs it on its release with --parent.

- Each index file matches docs/index.schema.json, and manifest.json matches
  docs/release-manifest.schema.json.
- The index files are one chain of layers: the lowest has "trees", and each
  other one extends the one under it. No package is in two index files.
  Each depends entry names a package of the same layer or of a layer under
  it, and each loads entry a package of any layer (the records were measured
  in the full scope). Each loads set is in order and does not have its own
  package. A file has its own loads record only in a measured package, and
  only if the set differs from the package's.
- manifest.json lists every other file of the release, with the correct size
  and SHA-512, except release-notes.md and sources/. The files marked
  "parent" are not in the release.
- Each source archive in sources/ is in the manifest's sources, with the
  correct size and SHA-512, and its asset name is not the name of a release
  archive. A child's sources are the parent's, and then its own repository.
- With --assembled (the release workflow): the manifest names a clean
  commit of the repository, and lazytex's release has all its source
  archives.
- Each releaseArchive URL names this release's tag and an archive of this
  release by its file name (or the parent release, for an entry that the
  child copied), and agrees with the manifest. Each release archive holds
  the indexed files of its package with their indexed sizes, and only
  regular files at safe paths. It can hold other files: the runfiles that
  the index does not list. No two archives have the same file name (their
  asset names).
- Each offline archive (archives/<layer>.tar.xz) holds the files of its
  layer.
- Each generated file is in the release, with the indexed size.
- Each bundle is a plain ustar file, and holds only indexed files (and
  pdflatex.fmt).
- The library (js/client.js, js/worker.js, js/types/client.d.ts,
  js/LICENSE.txt) and the engine's notices (busytex/NOTICE.html and its licence
  texts) are in the manifest, in this release or the parent's. The release
  has its own NOTICE.html.
- With --parent: the manifest names the parent release and the SHA-512 of its
  manifest, the parent files agree with the parent's manifest, no bundle file
  is in two bundles, and each package entry is the parent's entry without
  change, except for the releaseArchive and loads entries that this release
  adds (for packages that the parent does not host or measure).

  python3 check_release.py --release RELEASE --schemas DOCS [--parent PARENT_RELEASE] [--assembled]

The script needs the jsonschema package. uv installs it from the block at
the top of this file:

  uv run check_release.py --release RELEASE --schemas DOCS [--parent PARENT_RELEASE]
"""

import argparse
import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path

import jsonschema

FORMAT_PATH = "home/web_user/fmt/pdflatex.fmt"
ASSET_URL = re.compile(r"https://github\.com/(?P<repository>[^/]+/[^/]+)/releases/download/(?P<tag>[^/]+)/(?P<asset>[^/]+)")
BUNDLE_NAME = re.compile(r"bundle(-[a-z0-9-]+)?\.tar")
NOT_LISTED = ("release-notes.md", "sources/")
problems = []


def problem(text):
    problems.append(text)


def sha512_of(path):
    digest = hashlib.sha512()
    with open(path, "rb") as data:
        for chunk in iter(lambda: data.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_sizes(package):
    """{path: size} of a package. A file entry is a size, or {bytes, loads}."""
    return {path: entry if isinstance(entry, int) else entry["bytes"] for path, entry in package["files"].items()}


def safe_member(member):
    name = member.name
    return member.isfile() and not name.startswith("/") and ".." not in name.split("/")


def archive_listing(path):
    """{path: size} of the regular files of an archive; unsafe entries are problems."""
    listing = {}
    try:
        with tarfile.open(path) as archive:
            for member in archive.getmembers():
                if not safe_member(member):
                    problem(f"{path.name}: unsafe or non-file entry {member.name!r}")
                    continue
                listing[member.name] = member.size
    except (tarfile.TarError, EOFError, OSError) as error:
        problem(f"{path.name}: cannot read the archive ({error.__class__.__name__})")
        return None
    return listing


def holds_files(listing, files):
    """Whether an archive listing has each file with its size. An archive also
    has the runfiles that the index does not list."""
    return listing is not None and all(listing.get(path) == size for path, size in files.items())


def bundle_members(path):
    with tarfile.open(path, format=tarfile.USTAR_FORMAT) as bundle:
        return bundle.getmembers()


def layer_chain(indexes):
    """The index files from the lowest layer up, or None (a problem) if they are not one chain."""
    lowest = [index for index in indexes.values() if "extends" not in index]
    if len(lowest) != 1 or "trees" not in lowest[0]:
        problem("the index files must have exactly one lowest layer, with trees")
        return None
    chain = [lowest[0]]
    while len(chain) < len(indexes):
        above = [index for index in indexes.values() if index.get("extends") == chain[-1]["scope"]]
        if len(above) != 1:
            problem(f"the index files are not one chain of layers above {chain[-1]['scope']}")
            return None
        chain.append(above[0])
    return chain


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", required=True)
    parser.add_argument("--schemas", required=True, help="the docs directory with the JSON Schemas")
    parser.add_argument("--parent", help="the parent release, for a child release")
    parser.add_argument("--assembled", action="store_true", help="a release to publish: it needs a clean commit and its source archives")
    args = parser.parse_args()
    release, schemas = Path(args.release), Path(args.schemas)

    index_schema = json.loads((schemas / "index.schema.json").read_text())
    manifest_schema = json.loads((schemas / "release-manifest.schema.json").read_text())
    indexes = {path.name: json.loads(path.read_text()) for path in sorted((release / "index").glob("index-*.json"))}
    manifest = json.loads((release / "manifest.json").read_text())
    for name, index in indexes.items():
        for error in jsonschema.Draft202012Validator(index_schema).iter_errors(index):
            problem(f"{name}: {error.json_path}: {error.message}")
        if name != f"index-{index['scope']}.json":
            problem(f"{name}: its scope is {index['scope']}")
    for error in jsonschema.Draft202012Validator(manifest_schema).iter_errors(manifest):
        problem(f"manifest.json: {error.json_path}: {error.message}")
    if problems:
        return
    chain = layer_chain(indexes)
    if not chain:
        return

    # Layers, dependencies and loads records. A loads record was measured in
    # lazytex's full scope, so it can name a package of any layer.
    all_packages = {name for index in chain for name in index["packages"]}
    known = set()
    seen = set()
    for index in chain:
        name = f"index-{index['scope']}.json"
        both = seen & set(index["packages"])
        if both:
            problem(f"{name}: packages that a layer under it has: {sorted(both)[:5]}")
        seen |= set(index["packages"])
        known = seen
        for package_name, package in index["packages"].items():
            unknown = [dependency for dependency in package.get("depends", []) if dependency not in known]
            if unknown:
                problem(f"{name}: {package_name} depends on packages that the scope does not have: {unknown}")
            file_sets = {relative_path: entry["loads"] for relative_path, entry in package["files"].items() if isinstance(entry, dict)}
            if file_sets and "loads" not in package:
                problem(f"{name}: {package_name} has loads records for files but not for the package")
            for where, loads in ([("package", package["loads"])] if "loads" in package else []) + list(file_sets.items()):
                if loads != sorted(loads) or package_name in loads or any(other not in all_packages for other in loads):
                    problem(f"{name}: {package_name}: the loads of {where} are not in order, have the package itself, "
                            f"or name packages that no layer has")
                if where != "package" and loads == package.get("loads"):
                    problem(f"{name}: {package_name}: {where} has the same loads as its package")
    if any(index["texlive"] != chain[0]["texlive"] for index in chain) or (
            chain[0]["texlive"] != manifest["texlive"]):
        problem("the index files and the manifest disagree on the TeX Live release")

    # The manifest lists every other file, with the correct size and SHA-512.
    own_files = {path: entry for path, entry in manifest["files"].items() if not entry.get("parent")}
    parent_files = {path: entry for path, entry in manifest["files"].items() if entry.get("parent")}
    on_disk = {path.relative_to(release).as_posix() for path in release.rglob("*") if path.is_file()} - {"manifest.json"}
    on_disk = {relative_path for relative_path in on_disk if not relative_path.startswith(NOT_LISTED)}
    if on_disk != set(own_files):
        problem(f"manifest and files differ: not listed {sorted(on_disk - set(own_files))[:5]}, "
                f"missing {sorted(set(own_files) - on_disk)[:5]}")
    for relative_path, entry in own_files.items():
        path = release / relative_path
        if path.is_file() and (path.stat().st_size != entry["bytes"] or sha512_of(path) != entry["sha512"]):
            problem(f"{relative_path}: size or SHA-512 differs from the manifest")
    if parent_files and "parent" not in manifest:
        problem("the manifest has parent files, but no parent release")

    # Release archives: each URL names this release (or the parent release)
    # and one of its archives by its file name (the asset name), agrees with
    # the manifest, and the archive holds the package's files.
    archive_paths = {}
    for relative_path in own_files:
        if relative_path.startswith("archives/"):
            asset_name = relative_path.rsplit("/", 1)[-1]
            if asset_name in archive_paths:
                problem(f"two archives have the asset name {asset_name}")
            archive_paths[asset_name] = relative_path
    parent = manifest.get("parent")
    for index in chain:
        for name, package in index["packages"].items():
            archive = package.get("releaseArchive")
            if not archive:
                continue
            match = ASSET_URL.fullmatch(archive["url"])
            if match and parent and (match["repository"], match["tag"]) == (parent["repository"], parent["release"]):
                continue  # the parent's entry: checked against the parent's index below
            relative_path = match and archive_paths.get(match["asset"])
            if not match or (match["repository"], match["tag"]) != (manifest["repository"], manifest["release"]) or not relative_path:
                problem(f"{name}: releaseArchive URL {archive['url']} does not name an archive of this release or its parent")
                continue
            if own_files[relative_path] != {"bytes": archive["bytes"], "sha512": archive["sha512"]}:
                problem(f"{name}: releaseArchive differs from the manifest")
                continue
            if not holds_files(archive_listing(release / relative_path), file_sizes(package)):
                problem(f"{name}: the release archive does not hold the indexed files")
    layers = {index["scope"]: index for index in chain}
    for relative_path in own_files:
        match = re.fullmatch(r"archives/([^/]+)\.tar\.xz", relative_path)
        if not match:
            continue
        if match[1] not in layers:
            problem(f"{relative_path}: no layer has the name {match[1]}")
            continue
        layer_files = {path: size for package in layers[match[1]]["packages"].values() for path, size in file_sizes(package).items()}
        if not holds_files(archive_listing(release / relative_path), layer_files):
            problem(f"{relative_path} does not hold the files of the layer {match[1]}")

    # Generated files.
    for index in chain:
        for tree, entries in index["generated"].items():
            for relative_path, size in entries.items():
                path = release / "index" / "generated" / index["scope"] / tree / relative_path
                if not path.is_file() or path.stat().st_size != size:
                    problem(f"generated/{index['scope']}/{tree}/{relative_path}: missing or wrong size")

    # The sources: each archive in sources/ agrees with the manifest, and an
    # assembled release names a clean commit and has all its archives.
    attached = {source["asset"]: source for source in manifest["sources"] if "asset" in source}
    for asset_name in set(attached) & set(archive_paths):
        problem(f"{asset_name}: a source archive and a release archive have the same asset name")
    sources_dir = release / "sources"
    on_disk_sources = {path.name for path in sources_dir.iterdir()} if sources_dir.is_dir() else set()
    for asset_name in sorted(on_disk_sources - set(attached)):
        problem(f"sources/{asset_name} is not in the manifest's sources")
    for asset_name in sorted(on_disk_sources & set(attached)):
        path = sources_dir / asset_name
        if path.stat().st_size != attached[asset_name]["bytes"] or sha512_of(path) != attached[asset_name]["sha512"]:
            problem(f"sources/{asset_name}: size or SHA-512 differs from the manifest")
    own_source = manifest["sources"][-1]
    if own_source["name"] != manifest["repository"]:
        problem("the last source is not the release's own repository")
    if args.assembled:
        if not own_source["commit"] or own_source["commit"].endswith("-dirty"):
            problem(f"the release names no clean commit of {manifest['repository']} (commit: {own_source['commit']})")
        if not args.parent and set(attached) - on_disk_sources:
            problem(f"source archives missing from sources/: {sorted(set(attached) - on_disk_sources)}")
    if not (release / "release-notes.md").is_file():
        problem("release-notes.md is not in the release")

    # The library and the notices.
    for relative_path in ("js/client.js", "js/worker.js", "js/types/client.d.ts", "js/LICENSE.txt", "busytex/NOTICE.html",
                          "busytex/licenses/GPL-3.0.txt", "busytex/licenses/GPL-2.0.txt", "busytex/licenses/LGPL-2.1.txt"):
        if relative_path not in manifest["files"]:
            problem(f"{relative_path} is not in the release or its parent")
    if "NOTICE.html" not in own_files:
        problem("NOTICE.html is not in the release")

    # The bundles.
    dist = chain[0]["trees"]["texmf-dist"].lstrip("/")
    indexed = {path: size for index in chain for package in index["packages"].values() for path, size in file_sizes(package).items()}
    own_bundles = [path for path in own_files if BUNDLE_NAME.fullmatch(path)]
    bundle_files = {}
    for relative_path in own_bundles:
        if (release / relative_path).read_bytes()[257:262] != b"ustar":
            problem(f"{relative_path}: not in ustar format")
            continue
        for member in bundle_members(release / relative_path):
            if not member.isfile():
                problem(f"{relative_path}: entry {member.name!r} is not a regular file")
            elif member.name != FORMAT_PATH and indexed.get(member.name.removeprefix(dist + "/")) != member.size:
                problem(f"{relative_path}: {member.name} is not an indexed file of that size")
            bundle_files.setdefault(member.name, []).append(relative_path)
    if not any(BUNDLE_NAME.fullmatch(path) for path in manifest["files"]):
        problem("the release has no bundle")

    if args.parent:
        parent_dir = Path(args.parent)
        parent_manifest = json.loads((parent_dir / "manifest.json").read_text())
        if not parent:
            problem("--parent given, but the manifest names no parent release")
            return
        if (parent["repository"], parent["release"], parent["manifestSha512"]) != (
                parent_manifest["repository"], parent_manifest["release"], sha512_of(parent_dir / "manifest.json")):
            problem("the manifest's parent is not this parent release")
        if manifest["sources"][:-1] != parent_manifest["sources"]:
            problem("the sources are not the parent's sources and then this repository")
        for relative_path, entry in parent_files.items():
            listed = parent_manifest["files"].get(relative_path)
            if not listed or (listed["bytes"], listed["sha512"]) != (entry["bytes"], entry["sha512"]):
                problem(f"{relative_path}: differs from the parent's manifest")
        for relative_path in parent_files:
            if BUNDLE_NAME.fullmatch(relative_path) and (parent_dir / relative_path).is_file():
                for member in bundle_members(parent_dir / relative_path):
                    bundle_files.setdefault(member.name, []).append(relative_path)
        parent_packages = {}
        for path in (parent_dir / "index").glob("index-*.json"):
            parent_packages.update(json.loads(path.read_text())["packages"])
        for index in chain:
            for name, package in index["packages"].items():
                original = parent_packages.get(name)
                if original is None:
                    problem(f"{name}: not in the parent's index")
                    continue
                copied = dict(package)
                if "releaseArchive" not in original:
                    copied.pop("releaseArchive", None)
                if "loads" not in original:
                    copied.pop("loads", None)
                    copied["files"] = file_sizes(package)
                if copied != original:
                    problem(f"{name}: the entry differs from the parent's entry")
    twice = [path for path, bundles in bundle_files.items() if len(bundles) > 1]
    if twice:
        problem(f"files in two bundles: {twice[:5]}")


if __name__ == "__main__":
    main()
    for text in problems[:30]:
        print(text)
    print(f"{len(problems)} problems" if problems else "release OK")
    sys.exit(1 if problems else 0)

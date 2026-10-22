"""Lay out the files of a release as the assets of its GitHub release.

GitHub release assets cannot be in folders, so the files of a release
(make_release.py) become these assets, all with flat names:

  release-files.tar.xz   the files of the release that the app uses, at
                         their paths: each file that manifest.json lists and
                         this release has (not "parent"), except archives/,
                         and manifest.json itself
  manifest.json          also as an asset of its own, so that a reader can
                         get it without the tar
  <file name>            each file of archives/ (the package archives, and
                         the offline archives of a child)
  <asset>                each source archive of sources/ (lazytex's
                         assembled release)

release-notes.md is not an asset: it is the text of the GitHub release.
The bundles are plain tar files in release-files.tar.xz, so the asset is
compressed, and the app gets each bundle as the engine reads it.

The tar has the files in path order, with fixed metadata (time 0, owner 0,
mode 0644), compressed with xz (preset 9). After it writes the tar, the
script reads it again, and compares each file with the manifest. The other
assets are hard links to the files of the release, or copies if a link is
not possible.

  python3 pack_assets.py --release RELEASE --out ASSETS
"""

import argparse
import hashlib
import io
import json
import os
import shutil
import tarfile
from pathlib import Path

FILES_ASSET = "release-files.tar.xz"
MANIFEST = "manifest.json"


def sha512_of_bytes(data):
    return hashlib.sha512(data).hexdigest()


def link_or_copy(source, target):
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", required=True, help="the files of a release (make_release.py)")
    parser.add_argument("--out", required=True, help="a new directory for the assets")
    args = parser.parse_args()
    release, out = Path(args.release), Path(args.out)
    out.mkdir(parents=True)

    manifest_bytes = (release / MANIFEST).read_bytes()
    manifest = json.loads(manifest_bytes)
    own_files = {path: entry for path, entry in manifest["files"].items() if not entry.get("parent")}
    tar_paths = sorted(path for path in own_files if not path.startswith("archives/"))
    archive_paths = sorted(path for path in own_files if path.startswith("archives/"))
    source_paths = sorted((release / "sources").iterdir()) if (release / "sources").is_dir() else []

    # Each asset name once: the tar, the manifest, the archives and the sources.
    asset_names = [FILES_ASSET, MANIFEST, *(path.rsplit("/", 1)[-1] for path in archive_paths),
                   *(path.name for path in source_paths)]
    twice = sorted({name for name in asset_names if asset_names.count(name) > 1})
    if twice:
        raise SystemExit(f"asset names that two files have: {twice}")

    def tar_member(name, size):
        member = tarfile.TarInfo(name)
        member.size = size
        member.mode = 0o644
        member.mtime = 0
        return member

    with tarfile.open(out / FILES_ASSET, "w:xz", preset=9) as files_tar:
        for relative_path in tar_paths:
            with open(release / relative_path, "rb") as data:
                files_tar.addfile(tar_member(relative_path, own_files[relative_path]["bytes"]), data)
        files_tar.addfile(tar_member(MANIFEST, len(manifest_bytes)), io.BytesIO(manifest_bytes))

    # Read the tar again: each file once, with the size and SHA-512 of the manifest.
    expected = {path: (own_files[path]["bytes"], own_files[path]["sha512"]) for path in tar_paths}
    expected[MANIFEST] = (len(manifest_bytes), sha512_of_bytes(manifest_bytes))
    found = {}
    with tarfile.open(out / FILES_ASSET) as files_tar:
        for member in files_tar.getmembers():
            data = files_tar.extractfile(member).read() if member.isfile() else b""
            found[member.name] = (len(data), sha512_of_bytes(data))
    if found != expected:
        wrong = sorted(path for path in set(found) | set(expected) if found.get(path) != expected.get(path))
        raise SystemExit(f"{FILES_ASSET} differs from the manifest: {wrong[:5]}")

    (out / MANIFEST).write_bytes(manifest_bytes)
    for relative_path in archive_paths:
        link_or_copy(release / relative_path, out / relative_path.rsplit("/", 1)[-1])
    for path in source_paths:
        link_or_copy(path, out / path.name)
    total = sum(path.stat().st_size for path in out.iterdir())
    print(f"{len(asset_names)} assets, {total / 1e6:.1f} MB: {FILES_ASSET} "
          f"({(out / FILES_ASSET).stat().st_size / 1e6:.1f} MB), {MANIFEST}, "
          f"{len(archive_paths)} archives, {len(source_paths)} source archives")


if __name__ == "__main__":
    main()

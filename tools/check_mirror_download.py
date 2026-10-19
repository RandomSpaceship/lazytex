"""Download TeX Live packages from a historic mirror and check them against
the index, as an app does for mirror packages (docs/formats.md, "When a
compile needs packages").

For each package: download archive/<name>.r<revision>.tar.xz from the
frozen release, check its SHA-512 against the index, unpack its files to
--out/texmf-dist (without tlpkg/), and compare them with the index (every
indexed file is present, with the indexed size). With --tree, also compare
the bytes with the files of that tree.

This needs the network, so it is not part of `nix flake check`. Run it by
hand, for example once for each new TeX Live year:

  python3 tools/check_mirror_download.py \
      --index $(nix build --print-out-paths .#release)/index \
      --tree $(nix build --print-out-paths .#texlive-full | grep -v -- -man$)/share/texmf \
      chessboard chessfss skaknew
"""

import argparse
import hashlib
import io
import json
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

DEFAULT_MIRROR = "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/{year}/tlnet-final"
USER_AGENT = "lazytex-check (+https://github.com/RandomSpaceship/lazytex)"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", required=True, help="the index folder of a release (its index-*.json files)")
    parser.add_argument("--mirror", help="tlnet-final URL (default: the University of Utah historic archive)")
    parser.add_argument("--tree", help="share/texmf of the full tree, to compare the file contents")
    parser.add_argument("--out", default=".scratch/mirror-check", help="where to unpack the packages")
    parser.add_argument("packages", nargs="+")
    args = parser.parse_args()

    indexes = [json.loads(path.read_text()) for path in sorted(Path(args.index).glob("index-*.json"))]
    mirror = args.mirror or DEFAULT_MIRROR.format(year=indexes[0]["texlive"]["year"])
    packages = {name: (package, index["scope"]) for index in indexes for name, package in index["packages"].items()}
    out = Path(args.out) / "texmf-dist"
    out.mkdir(parents=True, exist_ok=True)
    failures = 0

    for name in args.packages:
        if name not in packages:
            print(f"{name}: not in the index")
            failures += 1
            continue
        package, scope = packages[name]
        revision, archive_bytes, sha512 = package["revision"], package["archiveBytes"], package["sha512"]
        url = f"{mirror}/archive/{name}.r{revision}.tar.xz"
        start = time.monotonic()
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read()
        download_ms = (time.monotonic() - start) * 1000
        problems = []
        if len(data) != archive_bytes:
            problems.append(f"size {len(data)}, index says {archive_bytes}")
        if hashlib.sha512(data).hexdigest() != sha512:
            problems.append("SHA-512 does not match the index")

        # A file entry is a size, or {bytes, loads} for a measured entry file.
        indexed = {path: entry if isinstance(entry, int) else entry["bytes"] for path, entry in package["files"].items()}
        unpacked = {}
        extra = []
        if not problems:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as archive:
                for member in archive.getmembers():
                    if not member.isfile() or member.name.startswith("tlpkg/"):
                        continue
                    if member.name not in indexed:
                        extra.append(member.name)
                        continue
                    content = archive.extractfile(member).read()
                    target = out / member.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
                    unpacked[member.name] = content
            for relative_path, size in indexed.items():
                if relative_path not in unpacked:
                    problems.append(f"missing: {relative_path}")
                elif len(unpacked[relative_path]) != size:
                    problems.append(f"size differs: {relative_path}")
                elif args.tree and (Path(args.tree) / relative_path).read_bytes() != unpacked[relative_path]:
                    problems.append(f"content differs from the tree: {relative_path}")

        failures += bool(problems)
        status = "OK" if not problems else "FAILED: " + "; ".join(problems[:5])
        print(f"{name} r{revision} ({scope}): {len(data)} bytes in {download_ms:.0f} ms, "
              f"{len(unpacked)} of {len(indexed)} indexed files"
              + (f" (same bytes as the tree)" if args.tree and not problems else "")
              + (f", {len(extra)} files not in the index" if extra else "")
              + f": {status}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()

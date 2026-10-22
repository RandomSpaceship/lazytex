"""Serve the example page (example/web/) with the example app's site.

The site has both releases (lazytex's and the example app's) in one
directory, as an app lays them out, and the full TeX tree at
texlive/texmf-dist as a stand-in for the app's package cache: every package
is "installed" already, so the page only tells the library about it. A real
app downloads each package archive, checks it and unpacks it first
(docs/formats.md, "When a compile needs packages").

  python3 serve.py --site SITE --page PAGE [--port 8050]

Then open http://127.0.0.1:8050/. Each request looks for its file in PAGE
first, then in SITE.
"""

import argparse
import hashlib
import http.server
import os


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", required=True)
    parser.add_argument("--page", required=True)
    parser.add_argument("--port", type=int, default=8050)
    args = parser.parse_args()

    class Handler(http.server.SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm"}

        # The page and the site change at each build, but every file in the
        # Nix store has the same modification time (1970), so an
        # If-Modified-Since check would keep a stale worker.js. The browser
        # checks each file (no-cache) with an ETag of the file's real path
        # (a new store path after each build), its time and its size.
        def send_head(self):
            self.etag = None
            file_path = self.translate_path(self.path)
            if os.path.isfile(file_path):
                stat = os.stat(file_path)
                key = f"{os.path.realpath(file_path)}:{stat.st_mtime_ns}:{stat.st_size}"
                self.etag = '"' + hashlib.sha256(key.encode()).hexdigest()[:32] + '"'
                if self.headers.get("If-None-Match") == self.etag:
                    self.send_response(http.HTTPStatus.NOT_MODIFIED)
                    self.end_headers()
                    return None
            # Only the ETag decides.
            del self.headers["If-Modified-Since"]
            return super().send_head()

        def end_headers(self):
            self.send_header("Cache-Control", "no-cache")
            if getattr(self, "etag", None):
                self.send_header("ETag", self.etag)
            super().end_headers()

        def translate_path(self, path):
            for root in (args.page, args.site):
                self.directory = root
                file_path = super().translate_path(path)
                if os.path.exists(file_path):
                    break
            return file_path

    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"http://127.0.0.1:{args.port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()

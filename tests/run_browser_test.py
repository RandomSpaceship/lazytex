"""Run the client's browser test (tests/browser/) in headless Chromium.

Serves the example app's site at /, the built library at /js/, the test page
at /test/, and the test documents at /test/documents/. The page posts its
results to /report. Exits with 1 if a check fails.

  python3 run_browser_test.py --site SITE --js JS --documents DOCUMENTS --page PAGE \
      --chromium CHROMIUM [--report FILE]
"""

import argparse
import http.server
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", required=True)
    parser.add_argument("--js", required=True)
    parser.add_argument("--documents", required=True)
    parser.add_argument("--page", required=True, help="the directory of the test page (tests/browser)")
    parser.add_argument("--chromium", default=shutil.which("chromium"))
    parser.add_argument("--report", help="write the results to this file")
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()
    roots = {
        "/js/": Path(args.js),
        "/test/documents/": Path(args.documents),
        "/test/": Path(args.page),
        "/": Path(args.site),
    }
    report = {}
    done = threading.Event()

    class Handler(http.server.SimpleHTTPRequestHandler):
        # Keep-alive connections, and no Nagle delay (headers and body are
        # separate writes, which otherwise stall each response by ~40 ms), so
        # that the timings are those of a fast local server.
        protocol_version = "HTTP/1.1"

        def setup(self):
            super().setup()
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def translate_path(self, path):
            path = path.split("?", 1)[0]
            for prefix, root in roots.items():
                if path.startswith(prefix):
                    relative = path[len(prefix):]
                    if ".." in relative.split("/"):
                        return str(root / "missing")
                    return str(root / relative)
            return str(Path(args.site) / "missing")

        def do_POST(self):
            if self.path != "/report":
                self.send_error(404)
                return
            report.update(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            done.set()

        def log_message(self, *_):
            pass

    Handler.extensions_map = {**Handler.extensions_map, ".js": "text/javascript", ".wasm": "application/wasm"}
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/test/index.html"
    with tempfile.TemporaryDirectory() as profile:
        # Chromium's log has the page's console messages, for a page that
        # does not send its report.
        browser_log = open(Path(profile) / "chromium.log", "w")
        browser = subprocess.Popen([args.chromium, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
                                    f"--user-data-dir={profile}/data", "--no-first-run", "--no-default-browser-check",
                                    "--enable-logging=stderr", "--remote-debugging-port=0", url],
                                   stdout=subprocess.DEVNULL, stderr=browser_log)
        try:
            finished = done.wait(args.timeout)
        finally:
            browser.terminate()
            try:
                browser.wait(timeout=10)
            except subprocess.TimeoutExpired:
                browser.kill()
            server.shutdown()
            browser_log.close()
            log_tail = (Path(profile) / "chromium.log").read_text(errors="replace").splitlines()[-40:]
    if not finished:
        print("\n".join(log_tail))
        sys.exit(f"no report after {args.timeout} s")
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2) + "\n")
    failed = [result for result in report["results"] if not result["pass"]]
    for result in report["results"]:
        print(("PASS " if result["pass"] else "FAIL ") + result["what"])
        if not result["pass"]:
            print("     " + json.dumps(result["detail"])[:1500])
    print(json.dumps(report.get("timings", {})))
    print(f"{len(report['results']) - len(failed)}/{len(report['results'])} checks passed")
    sys.exit(1 if failed or not report["results"] else 0)


if __name__ == "__main__":
    main()

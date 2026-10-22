# The demo site

The demo page of lazytex on GitHub Pages. It compiles a LaTeX document in
the browser, with the site of the example child ([`example/`](../example/)).

| Command | What it does |
|---|---|
| `nix run .#pages` | Serves the site on <http://127.0.0.1:8050/>. |
| `nix build .#pages` | Makes the static site. `.github/workflows/pages.yml` publishes it. |

The page runs the compile loop of
[`example/web/app.js`](../example/web/app.js), and adds these parts:

- A status: downloading (with a percentage), loading into memory,
  compiling, ready, done, errors, timed out, or stopped. A timer shows the
  time of the current start or compile.
- A bar for each download of the engine start (`busytex.wasm`, the index
  files, the bundles). If the server compressed a response, the bar uses
  the size from `manifest.json`.
- The files that TeX reads during a run, and their bytes.
- A stop button, which stops the worker at once.
- The errors, each with a button that selects its line in the document.
- The PDF, drawn with [PDF.js](https://mozilla.github.io/pdf.js/)
  (Apache-2.0): one canvas for each page, as wide as the preview. On a
  narrow screen, the preview is as tall as its pages. A browser's own PDF
  viewer in an iframe cannot do this, and Android Chrome does not show a PDF
  in an iframe. `default.nix` gets PDF.js from npm with a pinned hash, and
  puts it in `pdfjs/` with its licence. The page loads it at the first PDF.
  A link downloads the PDF.

A Pages site has a size limit of 1 GB, and the full tree is 3.9 GB. Thus
the site has only the packages of the medium scope (852 MB). When a
document needs a package outside the medium scope, the page shows a warning
and stops. A real app downloads the package
([`example/README.md`](../example/README.md), "Install packages in a
browser").

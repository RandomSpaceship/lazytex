# The example

A minimal child of lazytex, and a web page that compiles LaTeX with it.
[`docs/child-repos.md`](../docs/child-repos.md) walks through the child, and
[`default.nix`](default.nix) lists its parts.

## Run the page

| Command | What it does |
|---|---|
| `nix run .#example` | Serves the page on <http://127.0.0.1:8050/>, with the full TeX tree as the installed packages. |

[`serve.py`](serve.py) is a small static server: it looks for each file in
`web/` first, then in the site.

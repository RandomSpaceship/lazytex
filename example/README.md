# The example

A minimal child of lazytex, and a web page that compiles LaTeX with it.
[`docs/child-repos.md`](../docs/child-repos.md) walks through the child, and
[`default.nix`](default.nix) lists its parts.

## Run the page

| Command | What it does |
|---|---|
| `nix run .#example` | Serves the page on <http://127.0.0.1:8050/>, with the full TeX tree as the installed packages. |
| `nix build .#example-pages` | Makes the page as a static site for GitHub Pages, with the medium tree only. |

[`serve.py`](serve.py) is a small static server: it looks for each file in
`web/` first, then in the site. A Pages site has a size limit of 1 GB, and
the full tree is 3.9 GB. Thus the Pages site has only the packages of the
medium scope (852 MB), and `site.json` tells the page. When a document needs
a package outside the medium scope, the page shows a warning and stops.

## Install packages in a browser

The page does not download packages: both sites have them already. A real
app downloads each package when a compile result is `needs`. These notes
tell how a web page can do this. Nobody has built or tested it.
[`docs/formats.md`](../docs/formats.md), "When a compile needs packages",
gives the general procedure.

1. **Find the archive.** Read the package from the index. If it has a
   `releaseArchive`, the archive is at `releaseArchive.url`. If not, it is a
   mirror package: the archive is `archive/<name>.r<revision>.tar.xz` on a
   TeX Live historic mirror. Show a warning for mirror packages.
2. **Download it through a CORS proxy.** On 2026-10-19, six historic mirrors
   and GitHub release downloads did not send `Access-Control-Allow-Origin`,
   so a page cannot read their responses. Use a small proxy that you operate
   (for example a Cloudflare Worker that forwards to one mirror and adds the
   header), or put the archives on a server that sends the header. Do not
   trust the proxy: the next step checks each archive.
3. **Check the SHA-512** with `crypto.subtle.digest('SHA-512', bytes)`.
   Compare it with `releaseArchive.sha512`, or with the package's `sha512`
   for a mirror package.
4. **Unpack it.** Browsers cannot decompress xz (`DecompressionStream` does
   not have it), so the page needs an xz decoder in JavaScript or
   WebAssembly, and a tar reader. Obey the safety rules of `formats.md`:
   write only the regular files that the package's `files` lists, at the
   path from `files`, and check each size.
5. **Serve the files.** The engine's worker reads each file from
   `<baseUrl>texlive/texmf-dist/<path>` with a synchronous `GET`. Put the
   files in Cache Storage at those URLs, and let a service worker answer
   these requests from the cache. Test first that the synchronous requests
   of a dedicated worker go through the service worker in each target
   browser.
6. **Tell the engine.** Call `tex.packagesInstalled(names)`, and compile
   again. Keep the list of installed packages, and give it as
   `installedPackages` when the page starts the next time.

If the cache does not have a file of an installed package, the compile
result is an `error` with the message `could not read <path>: <reason>`.

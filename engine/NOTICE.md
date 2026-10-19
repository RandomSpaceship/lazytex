# The engine: licences and source

`busytex.js` and `busytex.wasm` are one program: pdfTeX from TeX Live,
compiled to WebAssembly with the build scripts of BusyTeX and with
Emscripten. lazytex distributes this program under the GNU General Public
License, version 3 or (at your option) any later version
([`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt)). pdfTeX is under
GPL-2.0-or-later, which permits this.

## Parts and their licences

| Part | Licence | Text |
|---|---|---|
| pdfTeX and web2c (TeX Live) | GPL-2.0-or-later | [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt) |
| xpdf, as TeX Live has it | GPL-2.0 or GPL-3.0 | [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt), [`licenses/GPL-3.0.txt`](licenses/GPL-3.0.txt) |
| kpathsea (TeX Live) | LGPL-2.1-or-later | [`licenses/LGPL-2.1.txt`](licenses/LGPL-2.1.txt) |
| SyncTeX (TeX Live) | MIT-style | [`licenses/synctex.txt`](licenses/synctex.txt) |
| libpng (TeX Live) | libpng-2.0 | [`licenses/libpng.txt`](licenses/libpng.txt) |
| zlib (TeX Live) | Zlib | [`licenses/zlib.txt`](licenses/zlib.txt) |
| `busytex.c` (BusyTeX) | MIT, according to BusyTeX's README. No licence file provided. | |
| Emscripten's JavaScript runtime and system libraries | MIT or UIUC/NCSA | [`licenses/emscripten.txt`](licenses/emscripten.txt) |
| musl libc (Emscripten) | MIT | [`licenses/musl.txt`](licenses/musl.txt) |
| libc++, libc++abi and compiler-rt (Emscripten) | Apache-2.0 WITH LLVM-exception | [`licenses/libcxx.txt`](licenses/libcxx.txt), [`licenses/libcxxabi.txt`](licenses/libcxxabi.txt), [`licenses/compiler-rt.txt`](licenses/compiler-rt.txt) |

The licence texts come from the source of this build.

## The source

The corresponding source of this build:

- TeX Live source: @texliveSource@
- BusyTeX's build scripts: https://github.com/busytex/busytex/tree/@busytex@
- Emscripten @emscripten@, from nixpkgs
- lazytex's build of the engine (`engine/default.nix`, with the pins in
  `flake.lock`): https://github.com/RandomSpaceship/lazytex, at the commit
  of the release that has this file

A build of the engine changes no file of TeX Live or BusyTeX.
`engine/default.nix` says which settings it gives to BusyTeX's Makefile.

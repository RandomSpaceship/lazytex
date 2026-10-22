# The demo page of lazytex on GitHub Pages: web/ with the site of the
# example child (example/), with the medium tree only. A Pages site has a
# size limit of 1 GB, and the full tree is 3.9 GB, so packages outside the
# medium scope are not installed.
#
#   site   the static site (nix build .#pages)
#   serve  `nix run .#pages`: the same site on http://127.0.0.1:8050/
{
  lib,
  fetchurl,
  runCommand,
  writeShellApplication,
  python3,
  lazytex,
  # The example child, and lazytex's release (its parent).
  example,
  parent,
}:
let
  scopes = lib.importJSON ../example/scopes.json;
  appSite = lazytex.appSite {
    name = "lazytex-pages-app-site";
    inherit (example) release;
    inherit parent;
    tree = lazytex.texlive.treeOf scopes.medium;
  };
  # PDF.js (Apache-2.0) shows the PDF, one canvas for each page. The legacy
  # build also works in older browsers. The PDFs of pdfTeX have their fonts
  # in them, so the site does not need the CMaps and the standard fonts.
  pdfjs = fetchurl {
    url = "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz";
    hash = "sha256-EBGzhVNTLXB4xZ8msVpHH42uAPEBtg4q3ZuFEXN6HOA=";
  };
  # The page (web/), and PDF.js in pdfjs/.
  page = runCommand "lazytex-pages-web" { } ''
    mkdir -p $out/pdfjs
    cp -r ${./web}/. $out/
    tar xzf ${pdfjs} -C $out/pdfjs --strip-components=3 package/legacy/build/pdf.min.mjs package/legacy/build/pdf.worker.min.mjs
    tar xzf ${pdfjs} -C $out/pdfjs --strip-components=1 package/LICENSE
  '';
in
{
  site = runCommand "lazytex-pages" { } ''
    mkdir $out
    ln -s ${appSite}/* ${page}/* $out/
  '';
  serve = writeShellApplication {
    name = "lazytex-pages";
    runtimeInputs = [ python3 ];
    text = ''
      exec python3 ${../example/serve.py} --site ${appSite} --page ${page} "$@"
    '';
  };
}

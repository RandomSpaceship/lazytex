# The tests of lazytex, on the site of the example app (example/), and the
# example page.
#
#   node          node --test on tests/*.test.cjs: the library with both
#                 releases, installs, scopes, formats, the scan and the
#                 normalizer (flake check `node`)
#   browser       the client and the real worker in headless Chromium
#                 (run_browser_test.py; flake check `browser`)
#   serveExample  `nix run .#example`: example/web/ with the example site
{
  runCommand,
  writeShellApplication,
  nodejs,
  poppler-utils,
  gnutar,
  xz,
  python3,
  chromium,
  fontconfig,
  library,
  site,
  documents,
  bundleDefinition,
}:
{
  node =
    runCommand "lazytex-node-tests"
      {
        nativeBuildInputs = [
          nodejs
          poppler-utils
          gnutar
          xz
        ];
      }
      ''
        export HOME=$TMPDIR TEX_SITE=${site} TEX_DOCUMENTS=${documents} TEX_JS=${library}/core.cjs \
          BUNDLE_DOCUMENTS=${bundleDefinition}
        node --test ${./.}/*.test.cjs
        touch $out
      '';

  browser =
    runCommand "lazytex-browser-test"
      {
        nativeBuildInputs = [ python3 ];
        FONTCONFIG_FILE = "${fontconfig.out}/etc/fonts/fonts.conf";
      }
      ''
        export HOME=$TMPDIR
        mkdir -p $out
        python3 ${./run_browser_test.py} --site ${site} --js ${library} --documents ${documents} \
          --page ${./browser} --chromium ${chromium}/bin/chromium --timeout 300 --report $out/report.json
      '';

  serveExample = writeShellApplication {
    name = "lazytex-example";
    runtimeInputs = [ python3 ];
    text = ''
      exec python3 ${../example/serve.py} --site ${site} --page ${../example/web} "$@"
    '';
  };
}

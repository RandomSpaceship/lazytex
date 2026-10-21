# A minimal child of lazytex: an app's own scopes, bundle and release, built
# with the functions of nix/lib.nix. lazytex's tests run on its site, and
# docs/child-repos.md walks through it. A real child repo has the same parts
# in its own flake, with lazytex as a flake input (lazytex.lib.<system>).
#
#   index     index-medium.json and index-full-extra.json, narrowed from the
#             full index of lazytex's release
#   trace     the files that the app's documents read, also with a format of
#             their own preamble
#   bundle    bundle.tar of the app: those files, without the files of
#             lazytex's bundle
#   archives  the packages of the app's bundle that lazytex does not host
#   loads     the measured loads records of those packages
#   release   the app's release (tag "development"), with a manifest that
#             also lists the files that it uses from lazytex's release
#   check     release/check_release.py with --parent
#   appSite   what the app serves: both releases in one directory, and the
#             full tree as a stand-in for installed packages
#   pages     the example page (web/) and appSite with the medium tree only,
#             for GitHub Pages (1 GB limit): packages outside the medium
#             scope are not installed
{
  lib,
  runCommand,
  lazytex,
  # lazytex's release: its index/ is the full index that the app narrows.
  parent,
}:
let
  scopes = lib.importJSON ./scopes.json;
  mediumTree = lazytex.texlive.treeOf scopes.medium;
  scope = [
    "index-medium.json"
    "index-${scopes.rest}.json"
  ];

  index = lazytex.narrowIndex {
    name = "example-index";
    full = "${parent}/index";
    layers = [
      {
        name = "medium";
        tree = mediumTree;
      }
    ];
    inherit (scopes) rest;
  };

  # The trace runs in the medium scope, the scope that the app starts in.
  mediumSite = lazytex.site {
    name = "example-site-medium";
    inherit index;
    tree = mediumTree;
  };
  trace = lazytex.traceBundle {
    name = "example-bundle-trace";
    site = mediumSite;
    scope = [ "index/index-medium.json" ];
    definition = ./bundle-documents.json;
    documents = ./documents;
  };
  bundle = lazytex.packBundle {
    name = "example-bundle";
    site = mediumSite;
    scope = [ "index/index-medium.json" ];
    inherit trace;
    excludeBundles = [ "${parent}/bundle.tar" ];
    withFormat = false;
  };

  archives = lazytex.makeArchives {
    name = "example-archives";
    inherit index scope;
    hosted = [ ];
    bundles = [ bundle ];
  };
  loads = lazytex.measureLoads {
    name = "example-loads";
    site = lazytex.site {
      name = "example-site-full";
      inherit index;
      tree = lazytex.texlive.full;
    };
    scope = map (file: "index/${file}") scope;
    packages = "${archives}/archives.json";
  };

  release = lazytex.makeRelease {
    name = "example-release";
    repository = "example-owner/example-app-resources";
    inherit index archives;
    bundles = {
      "bundle-example.tar" = bundle;
    };
    loads = [ loads ];
    inherit parent;
  };
in
{
  inherit
    index
    trace
    bundle
    archives
    loads
    release
    ;
  check = lazytex.checkRelease {
    name = "example-release-check";
    inherit release parent;
  };
  appSite = lazytex.appSite {
    name = "example-app-site";
    inherit release parent;
    tree = lazytex.texlive.full;
  };
  pages =
    let
      site = lazytex.appSite {
        name = "example-pages-site";
        inherit release parent;
        tree = mediumTree;
      };
    in
    runCommand "example-pages" { } ''
      mkdir $out
      ln -s ${site}/* ${./web}/* $out/
      echo '{ "mediumOnly": true }' > $out/site.json
    '';
}

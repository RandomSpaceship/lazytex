# The build functions of lazytex. lazytex's own release uses them, and a
# child repo (an app's own scopes and bundle) gets them as the flake output
# lib.<system>. docs/child-repos.md shows how a child uses them.
#
# Each function is a thin Nix wrapper around one tool of this repo, so a step
# is easy to run by hand as well (each tool's docstring has its command).
{
  lib,
  pkgs,
  # lazytex's engine, library and TeX Live (texlive/default.nix).
  engine,
  library,
  texlive,
}:
let
  inherit (pkgs)
    runCommand
    linkFarm
    writeText
    writeShellApplication
    python3
    nodejs
    xz
    ;
  pythonWithSchema = python3.withPackages (packages: [ packages.jsonschema ]);
  commas = lib.concatStringsSep ",";
  # make_index.py alone: the other tools import its functions. A directory
  # with only this file, so that a change to another tool of index/ does not
  # rebuild the index.
  makeIndexModule = lib.fileset.toSource {
    root = ../index;
    fileset = ../index/make_index.py;
  };
  schemas = lib.fileset.toSource {
    root = ../docs;
    fileset = lib.fileset.fileFilter (file: file.hasExt "json") ../docs;
  };
in
rec {
  inherit engine library texlive;

  # What the Node tools read: the engine at busytex/, an index directory at
  # index/ (index-*.json and generated/), and a TeX tree at
  # texlive/texmf-dist.
  site =
    {
      name,
      index,
      tree,
    }:
    linkFarm name {
      "busytex" = engine;
      "index" = index;
      "texlive/texmf-dist" = "${tree}/share/texmf";
    };

  # lazytex's full index (index/make_index.py): index-full.json and
  # generated/full/.
  makeIndex =
    {
      name ? "lazytex-index",
      tree ? texlive.full,
    }:
    runCommand name { nativeBuildInputs = [ python3 ]; } ''
      python3 ${../index/make_index.py} --tlpdb ${texlive.tlpdb} --package-sets ${texlive.packageSets} \
        --tree ${tree} --out $out
    '';

  # A child's scopes from lazytex's full index (index/narrow_index.py).
  #   full    a directory with index-full.json and generated/full/: the
  #           index/ of lazytex's release
  #   layers  [ { name; tree; } ], the lowest first. Make each tree with
  #           texlive.treeOf, so that it comes from lazytex's TeX Live.
  #   rest    the name of a last layer with all other packages, or null
  narrowIndex =
    {
      name,
      full,
      layers,
      rest ? null,
    }:
    runCommand name { nativeBuildInputs = [ python3 ]; } ''
      PYTHONPATH=${makeIndexModule} python3 ${../index/narrow_index.py} --full ${full} \
        --package-sets ${texlive.packageSets} \
        ${lib.concatMapStringsSep " " (layer: "--layer ${layer.name}=${layer.tree}") layers} \
        ${lib.optionalString (rest != null) "--rest ${rest}"} --out $out
    '';

  # The files that the documents and format builds of a bundle definition
  # read (bundle/trace_bundle.cjs). scope: the index files below the site,
  # for example [ "index/index-full.json" ].
  traceBundle =
    {
      name,
      site,
      scope,
      definition,
      documents,
    }:
    runCommand name { nativeBuildInputs = [ nodejs ]; } ''
      export HOME=$TMPDIR TEX_JS=${library}/core.cjs
      node ${../bundle/trace_bundle.cjs} ${site} ${commas scope} ${definition} ${documents} $out
    '';

  # A bundle from a trace (bundle/make_bundle.py): bundle.tar and stats.json.
  # A child leaves out the files of the bundles under it (excludeBundles: the
  # tar files), and pdflatex.fmt (withFormat = false).
  packBundle =
    {
      name,
      site,
      scope,
      trace,
      excludeBundles ? [ ],
      withFormat ? true,
    }:
    runCommand name { nativeBuildInputs = [ python3 ]; } ''
      python3 ${../bundle/make_bundle.py} --site ${site} --scope ${commas scope} --trace ${trace} \
        ${lib.concatMapStringsSep " " (bundle: "--exclude-bundle ${bundle}") excludeBundles} \
        ${lib.optionalString (!withFormat) "--without-format"} --out $out
    '';

  # The package archives of a release (archives/make_archives.py).
  #   index    a directory with the index files
  #   scope    their file names, for example [ "index-full.json" ]
  #   hosted   the package names to host (the build adds their dependencies)
  #   bundles  bundle outputs (with stats.json): host their packages too
  #   offline  layers to pack as one archive each, for offline use
  #   tree     a tree with every package of the scope
  # Packages that already have a releaseArchive (the parent hosts them) are
  # left out.
  makeArchives =
    {
      name,
      index,
      scope,
      hosted,
      bundles ? [ ],
      offline ? [ ],
      tree ? texlive.full,
    }:
    runCommand name
      {
        nativeBuildInputs = [
          python3
          xz
        ];
      }
      ''
        PYTHONPATH=${makeIndexModule} python3 ${../archives/make_archives.py} --index ${index} --scope ${commas scope} \
          --tlpdb ${texlive.tlpdb} --hosted ${writeText "hosted.json" (builtins.toJSON hosted)} \
          ${lib.concatMapStringsSep " " (bundle: "--bundle-stats ${bundle}/stats.json") bundles} \
          ${lib.concatMapStringsSep " " (layer: "--offline ${layer}") offline} \
          --tree ${tree}/share/texmf --out $out
      '';

  # The measured loads records (index/measure_loads.cjs) of the packages of
  # archives.json (the hosted packages) or of a JSON list. scope: the index
  # files below the site, all packages installed.
  measureLoads =
    {
      name,
      site,
      scope,
      packages,
    }:
    runCommand name { nativeBuildInputs = [ nodejs ]; } ''
      export HOME=$TMPDIR TEX_JS=${library}/core.cjs
      node ${../index/measure_loads.cjs} ${site} ${commas scope} ${packages} $out
    '';

  # The files of a release, with manifest.json (release/make_release.py), for
  # the tag "development", which is never published. passthru.assemble is the
  # tool of the release workflow: it writes the same files outside the Nix
  # sandbox with the real tag, so that the releaseArchive URLs name it, and
  # checks them:
  #
  #   nix run .#release-assemble -- TAG OUT   (lazytex's flake app; a child
  #                                           makes its own app from it)
  #
  #   bundles  { "bundle.tar" = bundle; } for lazytex, or
  #            { "bundle-<app>.tar" = bundle; } for a child
  #   parent   lazytex's release, for a child; null for lazytex's own release
  makeRelease =
    {
      name,
      repository,
      index,
      archives,
      bundles,
      loads ? [ ],
      parent ? null,
      release ? "development",
    }:
    let
      inputArguments = lib.concatStringsSep " " (
        [
          "--index ${index}"
          "--archives ${archives}"
        ]
        ++ lib.mapAttrsToList (bundleName: bundle: "--bundle ${bundleName}=${bundle}") bundles
        ++ map (records: "--loads ${records}") loads
        ++ (
          if parent == null then
            [
              "--engine ${engine}"
              "--js ${library}"
            ]
          else
            [ "--parent ${parent}" ]
        )
      );
      checkArguments = lib.optionalString (parent != null) "--parent ${parent}";
    in
    runCommand name
      {
        nativeBuildInputs = [ python3 ];
        passthru.assemble = writeShellApplication {
          name = "${name}-assemble";
          runtimeInputs = [ pythonWithSchema ];
          text = ''
            if [ $# -lt 2 ] || [ $# -gt 3 ]; then
              echo "usage: ${name}-assemble TAG OUT [OWNER/REPO]" >&2
              exit 2
            fi
            tag=$1 out=$2 repository=''${3:-${repository}}
            if [ -e "$out" ]; then
              echo "$out exists: give a new directory" >&2
              exit 2
            fi
            python3 ${../release/make_release.py} ${inputArguments} --release "$tag" --repository "$repository" --out "$out"
            python3 ${../release/check_release.py} --release "$out" --schemas ${schemas} ${checkArguments}
          '';
        };
      }
      ''
        python3 ${../release/make_release.py} ${inputArguments} --release ${release} --repository ${repository} --out $out
      '';

  # A flake check: release/check_release.py on a release.
  checkRelease =
    {
      name,
      release,
      parent ? null,
    }:
    runCommand name { nativeBuildInputs = [ pythonWithSchema ]; } ''
      python3 ${../release/check_release.py} --release ${release} --schemas ${schemas} \
        ${lib.optionalString (parent != null) "--parent ${parent}"}
      touch $out
    '';

  # What an app serves at its base URL, for tests and for local use: the
  # files of a child release and the files that it uses from the parent
  # release (the engine, the library and the parent's bundles), in one
  # directory, as the app lays them out. With tree, the site also serves
  # texlive/texmf-dist from it, as a stand-in for installed packages. The
  # archives of both releases are at archives/, so that the tests can
  # install packages without a download.
  appSite =
    {
      name,
      release,
      parent ? null,
      tree ? null,
    }:
    runCommand name { } ''
      mkdir -p $out/archives/hosted
      link() { for file in "$1"/*; do [ -e "$file" ] && ln -s "$file" "$2/"; done; }
      ${lib.optionalString (parent != null) ''
        ln -s ${parent}/busytex ${parent}/js $out/
        for bundle in ${parent}/bundle*.tar; do ln -s "$bundle" $out/; done
        link ${parent}/archives/hosted $out/archives/hosted
      ''}
      for entry in ${release}/*; do
        case "$(basename "$entry")" in
          archives) ;;
          *) ln -s "$entry" $out/ ;;
        esac
      done
      link ${release}/archives/hosted $out/archives/hosted
      for archive in ${release}/archives/*.tar.xz; do [ -e "$archive" ] && ln -s "$archive" $out/archives/; done
      ${lib.optionalString (tree != null) ''
        mkdir -p $out/texlive
        ln -s ${tree}/share/texmf $out/texlive/texmf-dist
      ''}
    '';
}

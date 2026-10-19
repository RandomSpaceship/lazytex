{
  description = "lazytex: pdfLaTeX in WebAssembly, with TeX files that load on demand";

  inputs = {
    # The latest stable NixOS branch. Change it to the next one at each NixOS
    # release (twice a year); flake.lock pins the commit.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    # BusyTeX's build scripts (Makefile, busytex.c), unforked. flake.lock pins the commit.
    busytex = {
      url = "github:busytex/busytex/eb36aae169f7d71e70760a84ef80156b33c0f820";
      flake = false;
    };
  };

  outputs =
    { nixpkgs, busytex, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      inherit (pkgs) lib;

      engineBuild = pkgs.callPackage ./engine { busytexSrc = busytex; };
      texlive = pkgs.callPackage ./texlive { };
      library = pkgs.callPackage ./library { };
      lazytex = import ./nix/lib.nix {
        inherit lib pkgs texlive library;
        engine = engineBuild.wasm;
      };

      # lazytex's own release: the full index, its bundle, the hosted
      # packages, and the measured loads of those packages.
      index = lazytex.makeIndex { };
      fullSite = lazytex.site {
        name = "lazytex-site-full";
        inherit index;
        tree = texlive.full;
      };
      fullScope = [ "index/index-full.json" ];
      bundleTrace = lazytex.traceBundle {
        name = "lazytex-bundle-trace";
        site = fullSite;
        scope = fullScope;
        definition = ./bundle/bundle-documents.json;
        documents = ./bundle/documents;
      };
      bundle = lazytex.packBundle {
        name = "lazytex-bundle";
        site = fullSite;
        scope = fullScope;
        trace = bundleTrace;
      };
      archives = lazytex.makeArchives {
        name = "lazytex-archives";
        inherit index;
        scope = [ "index-full.json" ];
        inherit (texlive) hosted;
        bundles = [ bundle ];
      };
      loads = lazytex.measureLoads {
        name = "lazytex-loads";
        site = fullSite;
        scope = fullScope;
        packages = "${archives}/archives.json";
      };
      release = lazytex.makeRelease {
        name = "lazytex-release";
        repository = "RandomSpaceship/lazytex";
        inherit index archives;
        bundles = {
          "bundle.tar" = bundle;
        };
        loads = [ loads ];
      };

      # The example child (example/): the tests run on its site.
      example = import ./example {
        inherit lib lazytex;
        inherit (pkgs) runCommand;
        parent = release;
      };
      tests = pkgs.callPackage ./tests {
        inherit library;
        site = example.appSite;
        documents = pkgs.linkFarm "lazytex-test-documents" (
          lib.mapAttrs' (name: _: lib.nameValuePair name "${./tests/documents}/${name}") (builtins.readDir ./tests/documents)
          // lib.mapAttrs' (name: _: lib.nameValuePair name "${./example/documents}/${name}") (builtins.readDir ./example/documents)
          // lib.mapAttrs' (name: _: lib.nameValuePair name "${./bundle/documents}/${name}") (builtins.readDir ./bundle/documents)
        );
        bundleDefinition = ./example/bundle-documents.json;
      };
    in
    {
      # The build functions for child repos (nix/lib.nix), with lazytex's
      # engine, library and TeX Live.
      lib.${system} = lazytex;

      packages.${system} = {
        engine = engineBuild.wasm;
        engine-native-tools = engineBuild.native-tools;
        inherit
          library
          index
          bundle
          archives
          loads
          release
          ;
        bundle-trace = bundleTrace;
        texlive-full = texlive.full;
        example-release = example.release;
        example-site = example.appSite;
        example-pages = example.pages;
        default = release;
      };

      apps.${system} = {
        # The release workflow: lazytex's release files for a tag, checked.
        release-assemble = {
          type = "app";
          program = "${release.assemble}/bin/lazytex-release-assemble";
          meta.description = "Assemble and check lazytex's release files for a tag (TAG OUT [OWNER/REPO])";
        };
        # The example page: compile a document in the browser.
        example = {
          type = "app";
          program = "${tests.serveExample}/bin/lazytex-example";
          meta.description = "Serve the example page on http://127.0.0.1:8050/";
        };
      };

      checks.${system} = {
        release = lazytex.checkRelease {
          name = "lazytex-release-check";
          inherit release;
        };
        example-release = example.check;
        node = tests.node;
        browser = tests.browser;
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [
          (pkgs.python3.withPackages (packages: [ packages.jsonschema ]))
          pkgs.nodejs
          pkgs.typescript
          pkgs.esbuild
          pkgs.chromium
          pkgs.poppler-utils
        ];
      };
    };
}

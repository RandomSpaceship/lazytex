# Build an app's own scopes and bundle (a child repo)

lazytex's release has the engine, the library, a general bundle and one full
index. An app usually wants more:

- a smaller default scope, so that the engine starts with a smaller index;
- a bundle with the files of its own typical documents (for example TikZ);
- formats that it builds on the device, with their files in its bundle;
- archives of the packages of its bundle that lazytex does not host.

A **child repo** builds these with the functions of lazytex's flake
(`lazytex.lib.<system>`, in [`nix/lib.nix`](../nix/lib.nix)), and publishes
them as its own release. [`example/`](../example/) is a complete minimal
child, and lazytex's tests run on it. quartz-resources is a real one.

## The steps

```
lazytex release ──▶ narrowIndex ──▶ index-medium.json, index-full-extra.json
                                     │
your documents ──▶ traceBundle ──▶ packBundle (without lazytex's files) ──▶ bundle-<app>.tar
                                     │
                    makeArchives (the bundle's packages that lazytex does not host)
                    measureLoads (the loads records of those packages)
                                     │
                    makeRelease (with parent = lazytex's release) ──▶ your release
                    checkRelease (with parent)
```

## A minimal flake

```nix
{
  inputs = {
    lazytex.url = "github:RandomSpaceship/lazytex";
    # The same nixpkgs as lazytex, so that your TeX trees come from the same
    # TeX Live as lazytex's index.
    nixpkgs.follows = "lazytex/nixpkgs";
  };

  outputs = { lazytex, nixpkgs, ... }:
    let
      system = "x86_64-linux";
      lt = lazytex.lib.${system};
      # lazytex's release. Until lazytex publishes a release, build it from
      # the flake input; then fetch the published one, pinned by its tag and
      # the SHA-512 of its index.
      parent = lazytex.packages.${system}.release;

      mediumTree = lt.texlive.treeOf {
        scheme = "scheme-medium";
        addCollections = [ "collection-latexextra" "collection-pictures" ];
      };
      index = lt.narrowIndex {
        name = "my-index";
        full = "${parent}/index";
        layers = [ { name = "medium"; tree = mediumTree; } ];
        rest = "full-extra";
      };
      mediumSite = lt.site { name = "my-site-medium"; inherit index; tree = mediumTree; };
      trace = lt.traceBundle {
        name = "my-bundle-trace";
        site = mediumSite;
        scope = [ "index/index-medium.json" ];
        definition = ./bundle-documents.json;
        documents = ./documents;
      };
      bundle = lt.packBundle {
        name = "my-bundle";
        site = mediumSite;
        scope = [ "index/index-medium.json" ];
        inherit trace;
        excludeBundles = [ "${parent}/bundle.tar" ];
        withFormat = false;
      };
      scope = [ "index-medium.json" "index-full-extra.json" ];
      archives = lt.makeArchives {
        name = "my-archives";
        inherit index scope;
        hosted = [ ];            # your own list, if lazytex does not host it
        bundles = [ bundle ];
        offline = [ "medium" ];  # optional: one archive of the medium layer
      };
      loads = lt.measureLoads {
        name = "my-loads";
        site = lt.site { name = "my-site-full"; inherit index; tree = lt.texlive.full; };
        scope = map (file: "index/${file}") scope;
        packages = "${archives}/archives.json";
      };
      release = lt.makeRelease {
        name = "my-release";
        repository = "me/my-app-resources";
        inherit index archives parent;
        bundles = { "bundle-my-app.tar" = bundle; };
        loads = [ loads ];
      };
    in {
      packages.${system}.release = release;
      apps.${system}.release-assemble = {
        type = "app";
        program = "${release.assemble}/bin/my-release-assemble";
      };
      checks.${system}.release = lt.checkRelease { name = "my-release-check"; inherit release parent; };
    };
}
```

`bundle-documents.json` names the documents (in `documents/`):

```json
{
  "documents": ["my-diagram", "my-plot"]
}
```

The trace compiles each document, builds a format of its own preamble
(`buildFormat()` with `mylatexformat`), and compiles the document with that
format. Thus the bundle has the files that the app needs to build formats
on the device. Put the app's default preamble (for example, of its TikZ
code blocks) in a document here.

## What each function does

| Function | Tool | Result |
|---|---|---|
| `texlive.treeOf { scheme, addCollections }` | nixpkgs' `texlive.withPackages` | A TeX tree of the collections of a scheme, without the ConTeXt, LuaTeX and XeTeX collections, plus the added ones. |
| `narrowIndex { full, layers, rest }` | `index/narrow_index.py` | `index-<layer>.json` for each layer and for the rest, with their generated files. Each package entry is lazytex's entry without change. |
| `site { index, tree }` | | The directory that the Node tools read: the engine, the index and a tree. |
| `traceBundle { site, scope, definition, documents }` | `bundle/trace_bundle.cjs` | The files that each document reads, also with a format of its own preamble, with all packages of the scope visible. |
| `packBundle { site, scope, trace, excludeBundles, withFormat }` | `bundle/make_bundle.py` | `bundle.tar` and `stats.json`. A child gives lazytex's `bundle.tar` in `excludeBundles` and `withFormat = false`. |
| `makeArchives { index, scope, hosted, bundles, offline }` | `archives/make_archives.py` | The archives of the hosted packages and their dependencies, and of the bundles' packages, without the packages that lazytex hosts. |
| `measureLoads { site, scope, packages }` | `index/measure_loads.cjs` | The `loads` records of the packages of `archives.json` that have none. |
| `makeRelease { repository, index, archives, bundles, loads, parent }` | `release/make_release.py` | The release (tag `development`), and `passthru.assemble`, the tool of the release workflow. |
| `checkRelease { release, parent }` | `release/check_release.py` | A flake check of the release. With `parent`, it also checks each copied entry against lazytex's. |
| `appSite { release, parent, tree }` | | What the app serves: both releases in one directory (for tests). |

## Publish a release

The Nix build uses the tag `development`. To publish:

1. Choose the tag, for example `v1.2.0`.
2. Run `nix run .#release-assemble -- v1.2.0 out/`. It writes the release
   files with the real tag in the archive URLs, and checks them.
3. Make a GitHub release with that tag, and upload the files of `out/`. The
   asset name of each archive is its file name.

Do not upload the files that the manifest marks `"parent": true`: the app
gets them from lazytex's release.

## What the app does with both releases

The app downloads both releases (or ships them), verifies each file against
the child's `manifest.json`, and serves them from one directory at its base
URL:

```ts
const tex = createTexEngine({
  baseUrl: 'http://my-app-tex.localhost/',
  createWorker: () => new Worker(new URL('./js/worker.js', import.meta.url)),
  scope: ['index/index-medium.json'],
  bundles: ['bundle.tar', 'bundle-my-app.tar'],
});
```

[`library/README.md`](../library/README.md) has the rest of the API.

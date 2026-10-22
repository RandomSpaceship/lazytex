# The library (library/README.md). TypeScript, checked with tsc and bundled
# with esbuild.
#
#   client.js  the API for apps (ES module)
#   worker.js  the engine's worker (classic script, for importScripts)
#   core.cjs   the synchronous engine, scope table and log parsing, for Node
#              (tests and build tools)
#   types/     the TypeScript declarations (client.d.ts for apps)
#   LICENSE.txt lazytex's licence (MIT), which apps ship with the library
#
# passthru.core is a directory with core.cjs only. It is built from the
# sources that core.ts imports, so that a change to client.ts, worker.ts or
# protocol.ts does not run the build tools (the bundle traces and the loads
# measurements) again. Use it for TEX_JS in Nix builds.
{
  lib,
  runCommand,
  typescript,
  esbuild,
}:
let
  # The modules of core.ts. If core.ts imports a module that is not in this
  # list, esbuild cannot find it and the build of core stops.
  coreSource = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./tsconfig.json
      ./src/core.ts
      ./src/scope.ts
      ./src/filesystem.ts
      ./src/engine.ts
      ./src/log.ts
      ./src/analysis.ts
      ./src/normalize.ts
      ./src/scan.ts
    ];
  };
  core =
    runCommand "lazytex-library-core"
      {
        nativeBuildInputs = [
          typescript
          esbuild
        ];
      }
      ''
        cp -r ${coreSource} source
        chmod -R u+w source
        cd source
        tsc --noEmit -p .
        mkdir -p $out
        esbuild src/core.ts --bundle --platform=neutral --format=cjs --target=es2022 --outfile=$out/core.cjs
      '';
in
runCommand "lazytex-library"
  {
    nativeBuildInputs = [
      typescript
      esbuild
    ];
    passthru = { inherit core; };
  }
  ''
    # Only the sources: a change to another file must not build the library
    # (and so the bundles and the archives) again.
    mkdir source
    cp -r ${./src} source/src
    cp ${./tsconfig.json} source/tsconfig.json
    chmod -R u+w source
    cd source
    tsc --noEmit -p .
    mkdir -p $out
    # The build that client.js and worker.js compare at each start
    # (protocol.ts): the hash of the store path of the sources.
    build=$(basename ${./src} | cut -d- -f1 | cut -c1-12)
    define="--define:LIBRARY_BUILD=\"$build\""
    esbuild src/client.ts --bundle --format=esm --target=es2022 "$define" --outfile=$out/client.js
    esbuild src/worker.ts --bundle --format=iife --target=es2022 "$define" --outfile=$out/worker.js
    cp ${core}/core.cjs $out/core.cjs
    tsc -p . --emitDeclarationOnly --outDir $out/types
    cp ${../LICENSE.md} $out/LICENSE.txt
  ''

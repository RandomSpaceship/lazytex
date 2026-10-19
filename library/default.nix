# The library (library/README.md). TypeScript, checked with tsc and bundled
# with esbuild.
#
#   client.js  the API for apps (ES module)
#   worker.js  the engine's worker (classic script, for importScripts)
#   core.cjs   the synchronous engine, scope table and log parsing, for Node
#              (tests and build tools)
#   types/     the TypeScript declarations (client.d.ts for apps)
#   LICENSE.md lazytex's licence (MIT), which apps ship with the library
{
  runCommand,
  typescript,
  esbuild,
}:
runCommand "lazytex-library"
  {
    nativeBuildInputs = [
      typescript
      esbuild
    ];
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
    esbuild src/client.ts --bundle --format=esm --target=es2022 --outfile=$out/client.js
    esbuild src/worker.ts --bundle --format=iife --target=es2022 --outfile=$out/worker.js
    esbuild src/core.ts --bundle --platform=neutral --format=cjs --target=es2022 --outfile=$out/core.cjs
    tsc -p . --emitDeclarationOnly --outDir $out/types
    cp ${../LICENSE.md} $out/LICENSE.md
  ''

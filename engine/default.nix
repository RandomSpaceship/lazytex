# The TeX engine: a pdfTeX-only BusyTeX build for WebAssembly.
#
# BusyTeX (the `busytex` flake input) is used unforked. Its Makefile is driven
# with make variable overrides and its own targets. Nothing in its sources or
# in TeX Live is patched. docs/design.md, "The engine", explains the overrides,
# and the comments below give the reason for each one.
#
#   sources       the source archives BusyTeX's Makefile would download
#   native-tools  native helper programs (tangle, ctangle, tie, web2c, ...) that
#                 the wasm build runs
#   wasm-objects  TeX Live configured and compiled for wasm: the libraries and
#                 pdfTeX objects that the link needs (the slow part)
#   wasm          the link: busytex.js + busytex.wasm + engine.json, and the
#                 notices: NOTICE.html (from ./NOTICE.html) and licenses/, the
#                 licence texts from the sources. A change to the link
#                 options rebuilds only this step.
{
  lib,
  stdenv,
  fetchurl,
  busytexSrc,
  python3,
  perl,
  autoconf,
  automake,
  libtool,
  gettext,
  gperf,
  pkg-config,
  libarchive,
  which,
  file,
  flex,
  bison,
  emscripten,
  nodejs,
  # The TeX Live source release to build from. BusyTeX pins 2023.0; 2026.1
  # builds with the same overrides and passes all tests (pdfTeX 1.40.29).
  texliveSource ? "2026.1",
}:
let
  texliveHashes = {
    # BusyTeX's pin (URL_texlive).
    "2023.0" = "sha256-sU7Ixoc64E13zR3iObZg4w89bw6XRJruZ+MwDqSiWf0=";
    "2026.1" = "sha256-HAyiOl+sjOAyPbEBcgxTnzJW3fnMDTDGqC85HP2k/gE=";
  };

  # The versions BusyTeX's Makefile pins (URL_texlive, URL_expat, URL_fontconfig),
  # except that texliveSource can choose a newer TeX Live release.
  sources = {
    texlive = fetchurl {
      url = "https://github.com/TeX-Live/texlive-source/archive/refs/heads/tags/texlive-${texliveSource}.tar.gz";
      hash = texliveHashes.${texliveSource};
    };
    expat = fetchurl {
      url = "https://github.com/libexpat/libexpat/releases/download/R_2_5_0/expat-2.5.0.tar.gz";
      hash = "sha256-a5AqsQOENZK+XplQT4RuwQnBq7aS6FNHWH8jek/6EDM=";
    };
    fontconfig = fetchurl {
      url = "https://github.com/fontconfig/fontconfig/archive/refs/tags/2.13.96.tar.gz";
      hash = "sha256-a+TrtYXtcql4BDPdixSRaGOvboz4wyiO7nPlYjptt10=";
    };
  };

  buildTools = [
    python3
    perl
    autoconf
    automake
    libtool
    gettext
    gperf
    pkg-config
    libarchive
    which
    file
    flex
    bison
  ];

  # The TeX Live package directories that pdfTeX needs configured.
  configuredPackages = [
    "libs/zlib"
    "libs/libpng"
    "libs/xpdf"
    "texk/kpathsea"
    "texk/web2c"
  ];

  # Copy BusyTeX and unpack the sources where its Makefile expects them. The
  # source/*.txt stamps tell make that the downloads are done.
  prepareTree = ''
    cp -r ${busytexSrc} busytex
    chmod -R u+w busytex
    cd busytex
    unpack() {
      mkdir -p "source/$1"
      tar -xzf "$2" -C "source/$1" --strip-components=1
      touch "source/$1.txt"
    }
    unpack texlive ${sources.texlive}
    unpack expat ${sources.expat}
    unpack fontconfig ${sources.fontconfig}
    patchShebangs --build source

    # TeX Live's configure runs the configure script of every package
    # directory whose script is executable, enabled or not (_KPSE_RECURSE in
    # m4/kpse-setup.m4). Its comment says this is meant to work with a
    # cut-down source tree, like pdfTeX's own. So make the configure scripts
    # of the packages that pdfTeX does not need non-executable. This removes
    # about 60 of the 70 configure runs; no source file changes.
    for script in source/texlive/{libs,texk,utils}/*/configure; do
      case "$script" in
        ${lib.concatMapStringsSep "|" (directory: "source/texlive/${directory}/configure") configuredPackages}) ;;
        *) chmod -x "$script" ;;
      esac
    done
  '';

  # BusyTeX's TEXBIN and WEB2CBIN lists: native programs the wasm build runs.
  texBinaries = [
    "ctangle"
    "otangle"
    "tangle"
    "tangleboot"
    "ctangleboot"
    "tie"
  ];
  web2cBinaries = [
    "fixwrites"
    "makecpool"
    "splitup"
    "web2c"
  ];

  native-tools = stdenv.mkDerivation {
    pname = "busytex-native-tools";
    version = texliveSource;
    dontUnpack = true;
    nativeBuildInputs = buildTools;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      ${prepareTree}
      # BusyTeX links native programs fully statically, and NixOS has no
      # static glibc. These are build tools only, so link them dynamically.
      make MAKEFLAGS=-j$NIX_BUILD_CORES LDFLAGS_TEXLIVE_native="-ldl -lm -pthread" build/native/texlive.configured
      make -C build/native/texlive/texk/web2c -j$NIX_BUILD_CORES ${lib.concatStringsSep " " texBinaries}
      make -C build/native/texlive/texk/web2c/web2c -j$NIX_BUILD_CORES ${lib.concatStringsSep " " web2cBinaries}
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out/web2c/web2c
      cp ${lib.concatMapStringsSep " " (name: "build/native/texlive/texk/web2c/${name}") texBinaries} $out/web2c/
      cp ${lib.concatMapStringsSep " " (name: "build/native/texlive/texk/web2c/web2c/${name}") web2cBinaries} $out/web2c/web2c/
      runHook postInstall
    '';
  };

  # The libraries pdfTeX links. BusyTeX's texlivedependencies target builds
  # every engine's libraries, so call the needed targets one by one.
  wasmTargets = [
    "build/wasm/texlive/libs/zlib/libz.a"
    "build/wasm/texlive/libs/libpng/libpng.a"
    "build/wasm/texlive/libs/xpdf/libxpdf.a"
    "build/wasm/texlive/texk/kpathsea/.libs/libkpathsea.a"
    "build/wasm/texlive/texk/web2c/lib/lib.a"
    "build/wasm/texlive/texk/web2c/busytex_libpdftex.a"
  ];

  exportedFunctions = [
    "_main"
    "_flush_streams"
    # The allocator's break, so the wrapper can reset exactly the used heap.
    "_emscripten_get_sbrk_ptr"
  ];
  exportedRuntimeMethods = [
    "callMain"
    "FS"
    "ENV"
    "PATH"
    "HEAPU8"
    "stackSave"
    "stackRestore"
  ];
  jsonList = list: "[" + lib.concatMapStringsSep "," (item: "\\\"${item}\\\"") list + "]";

  linkOptions = lib.concatStringsSep " " [
    "--static -static -static-libstdc++ -static-libgcc"
    # Grow from a small start instead of BusyTeX's fixed 512 MB.
    "-sINITIAL_MEMORY=64MB -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB"
    "-sEXIT_RUNTIME=0 -sINVOKE_RUN=0 -sASSERTIONS=0 -sFORCE_FILESYSTEM=1"
    "-sMODULARIZE=1 -sEXPORT_NAME=busytex"
    "-sEXPORTED_FUNCTIONS=${jsonList exportedFunctions}"
    "-sEXPORTED_RUNTIME_METHODS=${jsonList exportedRuntimeMethods}"
  ];

  # The files that the link step reads from the wasm build tree.
  linkInputs = [
    "build/wasm/texlive/texk/web2c/synctexdir/pdftex-synctex.o"
    "build/wasm/texlive/texk/web2c/pdftex-pdftexini.o"
    "build/wasm/texlive/texk/web2c/pdftex-pdftex0.o"
    "build/wasm/texlive/texk/web2c/pdftex-pdftex-pool.o"
    "build/wasm/texlive/texk/web2c/pdftexdir/pdftex-pdftexextra.o"
    "build/wasm/texlive/texk/web2c/lib/lib.a"
    "build/wasm/texlive/texk/web2c/libmd5.a"
    "build/wasm/texlive/texk/web2c/busytex_libpdftex.a"
    "build/wasm/texlive/texk/kpathsea/.libs/libkpathsea.a"
    "build/wasm/texlive/libs/libpng/libpng.a"
    "build/wasm/texlive/libs/zlib/libz.a"
    "build/wasm/texlive/libs/xpdf/libxpdf.a"
  ];

  # The notices of the engine: NOTICE.html with the versions of this build, and
  # the licence texts from the sources that the build used.
  licenses = ''
    mkdir -p $out/licenses texlive-licenses
    tar -xzf ${sources.texlive} -C texlive-licenses --strip-components=1 --wildcards \
      '*/texk/web2c/pdftexdir/COPYINGv2' '*/libs/xpdf/xpdf-src/COPYING3' '*/texk/kpathsea/COPYING.LESSERv2' \
      '*/texk/web2c/synctexdir/synctex.c' '*/libs/libpng/libpng-src/LICENSE' '*/libs/zlib/zlib-src/LICENSE'
    cp texlive-licenses/texk/web2c/pdftexdir/COPYINGv2 $out/licenses/GPL-2.0.txt
    cp texlive-licenses/libs/xpdf/xpdf-src/COPYING3 $out/licenses/GPL-3.0.txt
    cp texlive-licenses/texk/kpathsea/COPYING.LESSERv2 $out/licenses/LGPL-2.1.txt
    cp texlive-licenses/libs/libpng/libpng-src/LICENSE $out/licenses/libpng.txt
    cp texlive-licenses/libs/zlib/zlib-src/LICENSE $out/licenses/zlib.txt
    # SyncTeX has its licence only in the header of its source files.
    sed -n '2,/authorization from the copyright holder/p' texlive-licenses/texk/web2c/synctexdir/synctex.c > $out/licenses/synctex.txt
    emscriptenLib=${emscripten}/share/emscripten/system/lib
    cp ${emscripten}/share/emscripten/LICENSE $out/licenses/emscripten.txt
    cp $emscriptenLib/libc/musl/COPYRIGHT $out/licenses/musl.txt
    cp $emscriptenLib/libcxx/LICENSE.TXT $out/licenses/libcxx.txt
    cp $emscriptenLib/libcxxabi/LICENSE.TXT $out/licenses/libcxxabi.txt
    cp $emscriptenLib/compiler-rt/LICENSE.TXT $out/licenses/compiler-rt.txt
    substitute ${./NOTICE.html} $out/NOTICE.html \
      --subst-var-by texliveSource ${sources.texlive.url} \
      --subst-var-by busytex ${busytexSrc.rev or "unknown"} \
      --subst-var-by emscripten ${emscripten.version}
  '';

  # A writable copy of Emscripten's prebuilt cache (system libraries).
  emscriptenCache = ''
    cp -r ${emscripten}/share/emscripten/cache $TMPDIR/em-cache
    chmod -R u+w $TMPDIR/em-cache
    export EM_CACHE=$TMPDIR/em-cache
  '';

  wasm-objects = stdenv.mkDerivation {
    pname = "busytex-pdftex-wasm-objects";
    version = texliveSource;
    dontUnpack = true;
    # configure runs its test programs, compiled to JavaScript, with Node.
    nativeBuildInputs = buildTools ++ [
      emscripten
      nodejs
    ];
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      ${prepareTree}

      # The native helper programs, where BusyTeX's emcc_wrapper.py expects them.
      mkdir -p build/native/texlive/texk/web2c/web2c
      cp ${lib.concatMapStringsSep " " (name: "${native-tools}/web2c/${name}") texBinaries} build/native/texlive/texk/web2c/
      cp ${lib.concatMapStringsSep " " (name: "${native-tools}/web2c/web2c/${name}") web2cBinaries} build/native/texlive/texk/web2c/web2c/

      ${emscriptenCache}

      # configure runs its test programs, which Emscripten writes as scripts
      # starting with "#!/usr/bin/env node". The sandbox has no /usr/bin/env,
      # so name Node directly (Emscripten's EXECUTABLE setting). Not for the
      # final link: busytex.js must not start with a #! line.
      export EMCC_CFLAGS="-sEXECUTABLE=${nodejs}/bin/node"

      make MAKEFLAGS=-j$NIX_BUILD_CORES build/wasm/texlive.configured
      for target in ${lib.concatStringsSep " " wasmTargets}; do
        # PDFTEX_EXTERN empty: with pdfTeX alone, pdfTeX must define
        # nameoffile and namelength itself (XeTeX does in BusyTeX's build).
        # OPTS_PDFTEX_wasm: give the C++ compiler pdfTeX's symbol renames too,
        # so pdftoepdf.cc calls busypdftex_pdftex_fail and the like.
        make MAKEFLAGS=-j$NIX_BUILD_CORES PDFTEX_EXTERN= \
          OPTS_PDFTEX_wasm='CC="$(CCSKIP_TEX_wasm) emcc $(CFLAGS_PDFTEX) $(CFLAGS_OPT_wasm)" CXX="em++ $(CFLAGS_PDFTEX) $(CFLAGS_OPT_wasm)"' \
          "$target"
      done
      # An automake target of web2c that the skipped texlivedependencies step builds.
      emmake make -C build/wasm/texlive/texk/web2c -j$NIX_BUILD_CORES libmd5.a
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp --parents ${lib.concatStringsSep " " linkInputs} build/wasm/texlive/texk/web2c/*.c $out/
      runHook postInstall
    '';
  };

  wasm = stdenv.mkDerivation {
    pname = "busytex-pdftex-wasm";
    version = texliveSource;
    dontUnpack = true;
    nativeBuildInputs = [
      python3
      libarchive
      which
      emscripten
    ];
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      cp -r ${busytexSrc} busytex
      chmod -R u+w busytex
      cd busytex
      cp -r ${wasm-objects}/build .
      chmod -R u+w build
      ${emscriptenCache}
      make build/wasm/busytex.js \
        OPTS_BUSYTEX_COMPILE_wasm="-DBUSYTEX_PDFTEX" \
        OBJ_XETEX= OBJ_LUAHBTEX= OBJ_BIBTEX= OBJ_DVIPDF= OBJ_MAKEINDEX= \
        OBJ_KPATHSEA=.libs/libkpathsea.a \
        OBJ_DEPS="texlive/libs/libpng/libpng.a texlive/libs/zlib/libz.a texlive/libs/xpdf/libxpdf.a texlive/texk/kpathsea/.libs/libkpathsea.a" \
        OPTS_BUSYTEX_LINK_wasm="${linkOptions}"
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp build/wasm/busytex.js build/wasm/busytex.wasm $out/
      ${licenses}
      cat > $out/engine.json <<EOF
      {
        "name": "busytex-pdftex",
        "busytex": "${busytexSrc.rev or "unknown"}",
        "texliveSource": "${sources.texlive.url}",
        "emscripten": "${emscripten.version}",
        "engines": ["pdftex"]
      }
      EOF
      runHook postInstall
    '';
  };
in
{
  inherit
    sources
    native-tools
    wasm-objects
    wasm
    ;
}

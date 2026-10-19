# The pinned TeX Live of lazytex: the package database, and TeX trees.
#
#   tlpdb   texlive.tlpdb.xz of the frozen TeX Live year (the file that
#           nixpkgs' TeX Live is built from)
#   sets    package-sets.json, parsed
#   hosted  the "hosted" list (each name is checked at evaluation)
#   treeOf  a TeX tree for a set { scheme, addCollections ? [ ] }: the
#           collections of the scheme, without the excluded collections, plus
#           the added ones. A child repo uses it for its own scopes, so that
#           its trees come from the same TeX Live as lazytex's index.
#   full    the tree of the full scope: everything that the engine can load
#
# The trees come from nixpkgs' TeX Live, so the files come from the Nix binary
# cache and not from the TeX Live mirrors. The pinned nixpkgs has the frozen
# TeX Live 2025 (tlnet-final).
{ lib, texlive }:
let
  sets = lib.importJSON ./package-sets.json;

  collectionsOf =
    { scheme, addCollections ? [ ] }:
    let
      schemeCollections = map (package: package.pname) texlive.pkgs.${scheme}.tlDeps;
    in
    lib.subtractLists sets.excludeCollections schemeCollections ++ addCollections;

  # withPackages adds the dependencies of each collection.
  treeOf = set: texlive.withPackages (packages: map (name: packages.${name}) (collectionsOf set));
in
{
  tlpdb = texlive.tlpdb.xz;
  packageSets = ./package-sets.json;
  inherit sets treeOf collectionsOf;
  hosted = map (name: assert texlive.pkgs ? ${name}; name) sets.hosted;
  full = treeOf sets.full;
}

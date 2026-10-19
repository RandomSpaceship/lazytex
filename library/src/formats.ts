// Sources of a shared TikZ format: TikZ with a list of packages and
// libraries. The app owns the list (example/documents/format-contents.json
// is the example app's list).

export interface FormatContents {
  packages: string[];
  tikzLibraries: string[];
}

// kind 'package':  TikZ, the packages and the libraries, loaded before any
//                  class. Build without mylatexformat. Documents compile
//                  without changes.
// kind 'preamble': a full preamble with the standalone class. Build with
//                  mylatexformat. Documents need toPreambleForm().
export function formatSource(contents: FormatContents, kind: 'package' | 'preamble'): string {
  const packages = contents.packages.length ? contents.packages.join(',') : null;
  const libraries = contents.tikzLibraries.length ? contents.tikzLibraries.join(',') : null;
  if (kind === 'package') {
    return [
      '\\RequirePackage{tikz}',
      packages && `\\RequirePackage{${packages}}`,
      libraries && `\\usetikzlibrary{${libraries}}`,
      '\\dump',
    ].filter(Boolean).join('\n') + '\n';
  }
  if (kind === 'preamble') {
    return [
      '\\documentclass{standalone}',
      '\\usepackage{tikz}',
      packages && `\\usepackage{${packages}}`,
      libraries && `\\usetikzlibrary{${libraries}}`,
      '\\begin{document}',
      '\\end{document}',
    ].filter(Boolean).join('\n') + '\n';
  }
  throw new Error(`unknown format kind: ${kind}`);
}

// The form of a document for a mylatexformat-made format that already holds
// the class and the standard preamble: TeX skips the lines up to
// \endofdump, and the document's own preamble lines (without its
// \documentclass) still run.
export function toPreambleForm(texSource: string): string {
  const body = texSource.split('\n').filter((line) => !line.trimStart().startsWith('\\documentclass'));
  return ['% standard preamble: in the format', '\\endofdump', ...body].join('\n');
}

// Read TeX's log: the errors, and the files that a failed compile did not
// find.

// TeX breaks log lines after max_print_line (79) characters. Join such lines
// again, so that a file name or message is on one line.
export function unwrapTexLog(log: string | null | undefined): string {
  const joined: string[] = [];
  let current = '';
  for (const line of (log ?? '').split('\n')) {
    current += line;
    if (line.length !== 79) {
      joined.push(current);
      current = '';
    }
  }
  if (current) joined.push(current);
  return joined.join('\n');
}

function withExtension(name: string, extension: string): string[] {
  return /\.[a-z0-9]+$/i.test(name) ? [name, name + extension] : [name + extension, name];
}

// Errors that TeX, LaTeX, TikZ and pdfTeX write to the log when a file is
// missing. Each pattern gives the file names to look for, from its match, in
// order of preference.
const MISSING_FILE_PATTERNS: Array<[RegExp, (name: string) => string[]]> = [
  [/^! LaTeX Error: File `([^']+)' not found\./gm, (name) => withExtension(name, '.tex')],
  [/^! I can't find file `([^']+)'\./gm, (name) => {
    // pgfplots tries pgflibrarypgfplots.<name>.code.tex last, but the
    // library can also be tikzlibrarypgfplots.<name>.code.tex.
    const library = /^pgflibrarypgfplots\.(.+)\.code\.tex$/.exec(name);
    return library ? [name, `tikzlibrarypgfplots.${library[1]}.code.tex`] : withExtension(name, '.tex');
  }],
  [/^! Package tikz Error: I did not find the tikz library '([^']+)'\./gm,
    (library) => [`tikzlibrary${library}.code.tex`, `pgflibrary${library}.code.tex`]],
  // The font's name is a control sequence (\\x=cmr10) or an NFSS name
  // (LSB/skaknew/m/n/20=SkakNew-Diagram).
  [/^! Font \\?[^=\s]+=([^\s]+)(?: at [^ ]+)? not loadable: Metric \(TFM\) file not found/gm, (name) => withExtension(name, '.tfm')],
  [/^!pdfTeX error: [^(]*\(file ([^)]+)\): cannot open/gm, (name) => [name]],
];

// The forms of a missing file's name that TeX can also read: the other
// candidates that the log patterns give for it. findScope() uses them,
// because a needs result names only the first candidate.
export function alternativeFileNames(name: string): string[] {
  const tikzLibrary = /^tikzlibrary(.+)\.code\.tex$/.exec(name);
  if (tikzLibrary) return [name, `pgflibrary${tikzLibrary[1]}.code.tex`];
  const pgfplotsLibrary = /^pgflibrarypgfplots\.(.+)\.code\.tex$/.exec(name);
  if (pgfplotsLibrary) return [name, `tikzlibrarypgfplots.${pgfplotsLibrary[1]}.code.tex`];
  if (name.endsWith('.tex')) return [name, name.slice(0, -'.tex'.length)];
  return /\.[a-z0-9]+$/i.test(name) ? [name] : [name, name + '.tex'];
}

// For each missing file in the log: the names to look for in the index, in
// order of preference.
export function missingFileCandidates(log: string | null | undefined): string[][] {
  const unwrapped = unwrapTexLog(log);
  const found: string[][] = [];
  for (const [pattern, candidatesOf] of MISSING_FILE_PATTERNS) {
    for (const match of unwrapped.matchAll(pattern)) {
      const reported = match[1].slice(match[1].lastIndexOf('/') + 1);
      found.push(candidatesOf(reported));
    }
  }
  return found;
}

export interface TexError {
  message: string;
  // The line of the main document, if TeX gives one (l.<number>).
  line: number | null;
  // TeX's context lines, up to and including the l.<number> line.
  context: string;
}

// The errors in the log: each line that starts with '!', with the line
// number that TeX gives after it.
export function texErrors(log: string | null | undefined): TexError[] {
  const lines = unwrapTexLog(log).split('\n');
  const errors: TexError[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith('!')) continue;
    const message = lines[index].replace(/^!\s*/, '');
    const context: string[] = [];
    let line: number | null = null;
    for (let next = index + 1; next < lines.length && next <= index + 20; next++) {
      if (lines[next].startsWith('!')) break;
      context.push(lines[next]);
      const lineMatch = /^l\.(\d+)/.exec(lines[next]);
      if (lineMatch) {
        line = Number(lineMatch[1]);
        break;
      }
    }
    errors.push({ message, line, context: context.join('\n').trim() });
  }
  return errors;
}

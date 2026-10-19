// The scan of the preamble before a compile (library/README.md, "The
// scan"). It finds the loads that the preamble names, so that one `needs`
// result can give most packages before the engine runs.
//
// It has its own parser, and it does not use the normalizer. It is
// aggressive: it removes all comments and ignores what it does not
// understand. A mistake costs one download too many or one more round, never
// a wrong page or key: the engine always compiles the original source, and
// the log finds what the scan did not.

// One load of the preamble, for display (scan() gives the list).
export interface Operation {
  // class: \documentclass, \LoadClass. package: \usepackage, \RequirePackage.
  // tikzlibrary: \usetikzlibrary. pgflibrary: \usepgflibrary.
  // pgfplotslibrary: \usepgfplotslibrary. input: \input with a literal name.
  kind: 'class' | 'package' | 'tikzlibrary' | 'pgflibrary' | 'pgfplotslibrary' | 'input';
  names: string[];
  options: string[];
}

const KIND_OF_COMMAND: Record<string, Operation['kind']> = {
  documentclass: 'class',
  LoadClass: 'class',
  LoadClassWithOptions: 'class',
  usepackage: 'package',
  RequirePackage: 'package',
  RequirePackageWithOptions: 'package',
  usetikzlibrary: 'tikzlibrary',
  usepgflibrary: 'pgflibrary',
  usepgfplotslibrary: 'pgfplotslibrary',
  input: 'input',
};
const COMMAND = new RegExp(`\\\\(${Object.keys(KIND_OF_COMMAND).join('|')})(?![A-Za-z@])`, 'g');
// The end of the text that the scan reads: the document's body, or the end
// of a format source.
const PREAMBLE_END = /\\begin\s*\{document\}|\\dump(?![A-Za-z@])/;

// The source without comments: `%` and the rest of its line, except `\%`.
function withoutComments(source: string): string {
  let output = '';
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') {
      output += source.slice(index, index + 2);
      index++;
    } else if (character === '%') {
      const newline = source.indexOf('\n', index);
      if (newline === -1) break;
      index = newline - 1;
    } else {
      output += character;
    }
  }
  return output;
}

// A group that starts at `position` (after spaces) with `open`, up to its
// matching `close`, with nested braces and brackets. Null if there is none.
function groupAt(text: string, position: number, open: string, close: string): { content: string; end: number } | null {
  let start = position;
  while (start < text.length && /\s/.test(text[start])) start++;
  if (text[start] !== open) return null;
  let braces = 0;
  let brackets = 0;
  for (let index = start + 1; index < text.length; index++) {
    const character = text[index];
    if (character === '\\') { index++; continue; }
    if (braces === 0 && brackets === 0 && character === close) return { content: text.slice(start + 1, index), end: index + 1 };
    if (character === '{') braces++;
    else if (character === '}') braces--;
    else if (character === '[') brackets++;
    else if (character === ']') brackets--;
    if (braces < 0) return null;
  }
  return null;
}

// The items of a comma list at the top level (not inside braces or brackets).
function splitList(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of list) {
    if (character === '{' || character === '[') depth++;
    if (character === '}' || character === ']') depth--;
    if (character === ',' && depth === 0) {
      items.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  items.push(current);
  return items.map((item) => item.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

// A name that the scan can map to a file: no macros, groups or spaces.
const isLiteralName = (name: string) => /^[^\\#{}[\]\s]+$/.test(name);

// The loads of the preamble: the text before \begin{document} (or \dump).
// Without either, the scan reads nothing.
export function scanPreamble(source: string): Operation[] {
  const text = withoutComments(source.replace(/\r\n?/g, '\n'));
  const preambleEnd = PREAMBLE_END.exec(text);
  if (!preambleEnd) return [];
  const preamble = text.slice(0, preambleEnd.index);
  const operations: Operation[] = [];
  for (const match of preamble.matchAll(COMMAND)) {
    const kind = KIND_OF_COMMAND[match[1]];
    const afterCommand = (match.index as number) + match[0].length;
    let names: string[] = [];
    let options: string[] = [];
    if (kind === 'input') {
      const braced = groupAt(preamble, afterCommand, '{', '}');
      // \input name, the primitive form: the name ends at a space or a command.
      const plain = /^[ \t]*([^\s\\{}%]+)/.exec(preamble.slice(afterCommand));
      names = braced ? [braced.content.trim()] : plain ? [plain[1]] : [];
    } else {
      const optional = groupAt(preamble, afterCommand, '[', ']');
      const required = groupAt(preamble, optional ? optional.end : afterCommand, '{', '}');
      if (required) {
        names = splitList(required.content);
        options = optional ? splitList(optional.content) : [];
      } else if (optional && kind !== 'class' && kind !== 'package') {
        // \usetikzlibrary[a,b] and \usepgfplotslibrary[a,b] (the bracket form).
        names = splitList(optional.content);
      }
    }
    names = names.filter(isLiteralName);
    if (names.length) operations.push({ kind, names, options });
  }
  return operations;
}

// The file names that each name of an operation can load, in the order that
// TeX tries them.
export function fileCandidatesOf({ kind, names }: Operation): string[][] {
  return names.map((name) => {
    switch (kind) {
      case 'class': return [`${name}.cls`];
      case 'package': return [`${name}.sty`];
      case 'tikzlibrary': return [`tikzlibrary${name}.code.tex`, `pgflibrary${name}.code.tex`];
      case 'pgflibrary': return [`pgflibrary${name}.code.tex`];
      case 'pgfplotslibrary': return [`tikzlibrarypgfplots.${name}.code.tex`, `pgflibrarypgfplots.${name}.code.tex`];
      case 'input': {
        const baseName = name.slice(name.lastIndexOf('/') + 1);
        return /\.[A-Za-z0-9]+$/.test(baseName) ? [baseName, `${baseName}.tex`] : [`${baseName}.tex`, baseName];
      }
    }
  });
}

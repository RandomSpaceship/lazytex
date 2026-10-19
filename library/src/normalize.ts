// The source normalizer for the cache keys: the format key, and an app's own
// keys, for example for cached SVGs (library/README.md, "The source
// normalizer"). The engine always compiles the original source, so a
// mistake here can change a key, but never a page.
//
// It is conservative: where it is not sure, it changes nothing. Two sources
// that TeX can read differently must keep different keys, because one key
// for both shows a wrong SVG or loads a wrong format. A key that is too
// strict only costs a new build.

// Environments whose text TeX reads with other catcodes, so that `%` is not
// a comment: each name that contains one of these words (verbatim*,
// Verbatim, BVerbatim, lstlisting, minted, …).
const PROTECTED_ENVIRONMENT = /verbatim|listing|minted/i;

// Commands that change what `%` is, or that make a verbatim command or
// environment with a name that the rules below do not see. If the source has
// one of them, the normalizer removes no comments.
const UNSAFE_COMMANDS = new RegExp('\\\\(?:' + [
  'catcode',
  // fancyvrb, listings, minted, tcolorbox: new verbatim names.
  'DefineShortVerb', 'MakeShortVerb', 'lstMakeShortInline',
  'DefineVerbatimEnvironment', 'CustomVerbatimEnvironment', 'RecustomVerbatimEnvironment',
  'CustomVerbatimCommand', 'RecustomVerbatimCommand',
  'lstnewenvironment', 'newminted', 'newmint', 'newmintinline', 'newmintedfile',
  'newtcblisting', 'renewtcblisting', 'NewTCBListing', 'RenewTCBListing', 'DeclareTCBListing', 'ProvideTCBListing',
  // A `v` argument of an xparse command is verbatim.
  'NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand', 'DeclareDocumentCommand',
  'NewDocumentEnvironment', 'RenewDocumentEnvironment', 'ProvideDocumentEnvironment', 'DeclareDocumentEnvironment',
  // The command form of an environment, for example in \newenvironment.
  'verbatim', 'Verbatim', 'BVerbatim', 'LVerbatim', 'lstlisting', 'minted',
].join('|') + ')(?![A-Za-z])');

// Inline commands whose argument can be verbatim. \verb cannot go past the
// end of its line. The others can have a brace argument over more lines.
const VERBATIM_INLINE = new Set(['lstinline', 'mintinline', 'url']);

const isLetter = (character: string) => /^[A-Za-z]$/.test(character);

// The position after the end of the line that has `position`.
function endOfLine(source: string, position: number): number {
  const newline = source.indexOf('\n', position);
  return newline === -1 ? source.length : newline + 1;
}

// The end of a protected inline argument that starts at `position`: the end
// of the first line where all braces from `position` are closed again. Braces
// are counted as raw characters. If they never close, the rest of the source.
function endOfBraceArgument(source: string, position: number): number {
  let depth = 0;
  for (let index = position; index < source.length; index++) {
    const character = source[index];
    if (character === '{') depth++;
    else if (character === '}') depth--;
    else if (character === '\n' && depth <= 0) return index + 1;
  }
  return source.length;
}

// Removes the text of each comment and keeps its `%`, so that the line end
// still gives no space. Protected text stays as it is.
function removeComments(source: string): string {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '%') {
      output += '%';
      const newline = source.indexOf('\n', index);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (character !== '\\') {
      output += character;
      index++;
      continue;
    }
    // A control sequence: a control word (letters), or a control symbol
    // (one other character, for example \% or \\).
    let nameEnd = index + 1;
    if (nameEnd < source.length && isLetter(source[nameEnd])) {
      while (nameEnd < source.length && isLetter(source[nameEnd])) nameEnd++;
    } else if (nameEnd < source.length) {
      nameEnd++;
    }
    const name = source.slice(index + 1, nameEnd);
    let protectedEnd = nameEnd;
    if (name === 'verb') {
      protectedEnd = endOfLine(source, nameEnd);
    } else if (VERBATIM_INLINE.has(name)) {
      protectedEnd = endOfBraceArgument(source, nameEnd);
    } else if (name === 'begin') {
      const environment = /^[ \t]*\{([^{}\n]*)\}/.exec(source.slice(nameEnd, nameEnd + 200));
      if (environment && PROTECTED_ENVIRONMENT.test(environment[1])) {
        const endCommand = `\\end{${environment[1]}}`;
        const end = source.indexOf(endCommand, nameEnd);
        protectedEnd = end === -1 ? source.length : end + endCommand.length;
      }
    }
    output += source.slice(index, protectedEnd);
    index = protectedEnd;
  }
  return output;
}

// The source as the cache keys see it:
// - CRLF becomes LF;
// - spaces at the end of each line go (TeX removes them when it reads a line);
// - blank lines at the end of the source go, and the result ends with one
//   line end;
// - the text of each comment goes, but its `%` stays. Not in protected text
//   (\verb, \verb*, \lstinline, \mintinline, \url, and environments whose
//   name contains verbatim, listing or minted), and not at all if the source
//   has \catcode or makes its own verbatim commands (UNSAFE_COMMANDS).
// Blank lines inside the text (\par) and spaces inside a line stay.
export function normalizeSource(source: string): string {
  let text = source.replace(/\r\n/g, '\n');
  if (!UNSAFE_COMMANDS.test(text)) text = removeComments(text);
  text = text.replace(/ +$/gm, '').replace(/\n+$/, '');
  return text ? text + '\n' : '';
}

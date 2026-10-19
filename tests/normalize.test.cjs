// Tests for normalizeSource(), the source normalizer of the cache keys (the
// format key, and an app's own keys). The engine compiles the original source,
// so the normalizer must never give one key to two sources that TeX reads
// differently: sources that differ only in protected text keep different
// results. The test documents give the same page after normalization.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { library, bundleDefinition, LAZYTEX_BUNDLE_DOCUMENTS, newEngine, readDocument, assertCompiled, renderFirstPage } = require('./helpers.cjs');

const { normalizeSource } = library;
const DOCUMENTS = process.env.TEX_DOCUMENTS;
// The documents that compile with the bundles only (no installs).
const BUNDLE_DOCUMENTS = [...LAZYTEX_BUNDLE_DOCUMENTS, ...bundleDefinition.documents];

test('normalize: line ends, spaces at line ends, and blank lines at the end', () => {
  assert.equal(normalizeSource('a  \r\nb\t \r\n\r\n\n  \n'), 'a\nb\t\n');
  assert.equal(normalizeSource(''), '');
  assert.equal(normalizeSource('\n\n'), '');
  assert.equal(normalizeSource('a'), normalizeSource('a\n'));
});

test('normalize: blank lines and spaces inside the text stay', () => {
  assert.equal(normalizeSource('a\n\n\nb  c\n  d\n'), 'a\n\n\nb  c\n  d\n');
});

test('normalize: a comment keeps its %, and loses its text', () => {
  assert.equal(normalizeSource('a% one\n  % two\nb %\n'), 'a%\n  %\nb %\n');
  assert.equal(normalizeSource('\\def\\x{a% end\n}\n'), '\\def\\x{a%\n}\n');
});

test('normalize: \\% is not a comment, and \\\\% is', () => {
  assert.equal(normalizeSource('50\\% done % note\n'), '50\\% done %\n');
  assert.equal(normalizeSource('a\\\\% note\n'), 'a\\\\%\n');
});

test('normalize: comments in protected text stay', () => {
  const unchanged = [
    '\\verb|50%|abc\n',
    '\\verb*+50% x+ % also kept on this line\n',
    '\\lstinline|a % b|\n',
    '\\lstinline[language=TeX]{a % b}\n',
    '\\mintinline{latex}{a % b}\n',
    '\\mintinline{latex}|a % b|\n',
    '\\url{http://example.com/a%20b}\n',
    '\\url{http://example.com/a%\nb}\n',
    '\\begin{verbatim}\n% kept\n\\end{verbatim}\n',
    '\\begin{verbatim*}\n% kept\n\\end{verbatim*}\n',
    '\\begin{Verbatim}[frame=single]\n% kept\n\\end{Verbatim}\n',
    '\\begin{lstlisting}\n% kept\n\\end{lstlisting}\n',
    '\\begin {minted}{latex}\n% kept\n\\end{minted}\n',
    '\\begin{verbatim}\n% no end, so the rest stays\n',
  ];
  for (const source of unchanged) assert.equal(normalizeSource(source), source, JSON.stringify(source));
});

test('normalize: comments after protected text go', () => {
  assert.equal(normalizeSource('\\verb|%|\n% after\n'), '\\verb|%|\n%\n');
  assert.equal(normalizeSource('\\begin{verbatim}\n%\n\\end{verbatim} % after\n'), '\\begin{verbatim}\n%\n\\end{verbatim} %\n');
  assert.equal(normalizeSource('\\begin{comment}\n% x\n\\end{comment}\n'), '\\begin{comment}\n%\n\\end{comment}\n');
});

test('normalize: protected text in a comment is part of the comment', () => {
  assert.equal(normalizeSource('% \\begin{verbatim}\n% x\n'), '%\n%\n');
});

test('normalize: sources that differ only in protected text keep different results', () => {
  const pairs = [
    ['\\verb|50%|abc\n', '\\verb|50%|xyz\n'],
    ['\\lstinline{a % b}\n', '\\lstinline{a % c}\n'],
    ['\\url{a%20b}\n', '\\url{a%20c}\n'],
    ['\\begin{lstlisting}\n% one\n\\end{lstlisting}\n', '\\begin{lstlisting}\n% two\n\\end{lstlisting}\n'],
  ];
  for (const [a, b] of pairs) assert.notEqual(normalizeSource(a), normalizeSource(b), `${a} / ${b}`);
});

test('normalize: no comment removal if the source can change what % is', () => {
  for (const command of ['\\catcode`\\%=12', '\\MakeShortVerb{\\|}', '\\DefineVerbatimEnvironment{code}{Verbatim}{}',
    '\\lstnewenvironment{code}{}{}', '\\newminted{latex}{}', '\\NewDocumentCommand{\\code}{v}{#1}',
    '\\newenvironment{code}{\\verbatim}{\\endverbatim}']) {
    const source = `${command}\na % one\n`;
    assert.equal(normalizeSource(source), source, command);
  }
  // A longer command name is not one of them.
  assert.equal(normalizeSource('\\catcodes % x\n'), '\\catcodes %\n');
  // The safe changes still apply.
  assert.equal(normalizeSource('\\catcode`\\%=12 \r\na % one  \n\n'), '\\catcode`\\%=12\na % one\n');
});

test('normalize: a second pass changes nothing', () => {
  for (const fileName of fs.readdirSync(DOCUMENTS).filter((name) => name.endsWith('.tex'))) {
    const once = normalizeSource(fs.readFileSync(path.join(DOCUMENTS, fileName), 'utf8'));
    assert.equal(normalizeSource(once), once, fileName);
  }
});

test('normalize: a change to the comments of a test document keeps the result', () => {
  const source = readDocument('motor-circuit');
  const otherComments = source.replace(/(?<!\\)%[^\n]*/g, '% other text');
  assert.notEqual(otherComments, source);
  assert.equal(normalizeSource(otherComments), normalizeSource(source));
});

let engine;
before(async () => {
  ({ engine } = await newEngine());
});

// The engine compiles the original source, but a normalized source must
// still be the same document. This finds a rule that changes what TeX reads.
for (const name of BUNDLE_DOCUMENTS) {
  test(`normalize: ${name} gives the same page after normalization`, () => {
    const pageOf = (source, what) => {
      const result = engine.compile(source, { formatName: 'pdflatex' });
      assertCompiled(result, what);
      return renderFirstPage(result.pdf);
    };
    assert.ok(pageOf(normalizeSource(readDocument(name)), `${name} (normalized)`).equals(pageOf(readDocument(name), name)), 'rendered page differs');
  });
}

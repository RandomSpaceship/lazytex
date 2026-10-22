// The demo page on GitHub Pages: the compile loop of example/web/app.js, with
// a status, progress for the downloads and the TeX runs, a stop button, and a
// timer.
//
// The site has only the packages of the medium scope (pages/default.nix), so
// a document that needs a package outside it stops with a warning. A real app
// downloads the package (example/README.md, "Install packages in a browser").
//
// The paths are relative to this file, so that the page works below a path.
import { createTexEngine } from './js/client.js';

// The example app's scopes, smallest first, and its bundles, lazytex's first.
const MEDIUM = ['index/index-medium.json'];
const FULL = ['index/index-medium.json', 'index/index-full-extra.json'];
const BUNDLES = ['bundle.tar', 'bundle-example.tar'];
const MAX_ROUNDS = 10;

// The current compile: the page runs one at a time.
let compiling = false;
let stopRequested = false;
let timerInterval = null;
let compileCount = 0;

const element = (id) => document.getElementById(id);
const sourceInput = element('source');
const compileButton = element('compile');
const stopButton = element('stop');

// The size of each release file, for downloads without a Content-Length
// (for example a compressed response).
const sizeOfFile = new Map();
fetch('manifest.json')
  .then((response) => (response.ok ? response.json() : { files: {} }))
  .then((manifest) => { for (const [path, entry] of Object.entries(manifest.files ?? {})) sizeOfFile.set(path, entry.bytes); })
  .catch(() => {});

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const formatSeconds = (milliseconds) => `${(milliseconds / 1000).toFixed(1)} s`;
const fileNameOf = (path) => path.slice(path.lastIndexOf('/') + 1);

// The status at the top: kind is ready, busy, warning, error or stopped.
// While the worker downloads or loads its files, the status shows that
// instead (statusOfEngine).
const status = { kind: 'busy', label: 'Starting the engine…' };
function setStatus(kind, label) {
  status.kind = kind;
  status.label = label;
  scheduleRender();
}

// What the page does now, in words.
const setPhase = (text) => { element('phase').textContent = text; };

// The progress of the downloads and of the current run, from onProgress.
// One render for each animation frame: a run can report hundreds of files.
const progress = {
  downloads: new Map(),
  // The next download report starts a new list (a new worker start).
  downloadsFinished: true,
  // From the end of a download of the engine or a bundle (the worker then
  // compiles and unpacks it), or from the 'files' report, to the 'started'
  // report.
  loadingIntoMemory: false,
  run: null,
};
let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderProgress();
  });
}

const STAGE_LABELS = { engine: 'Engine', index: 'Index', bundle: 'Bundle' };

const totalOf = (file, { total }) => total ?? sizeOfFile.get(file) ?? null;
const isFinished = ({ loaded, total }) => total !== null && loaded === total;

// The status of the engine start, or null if the worker does not download
// or load files now.
function statusOfEngine() {
  const downloads = [...progress.downloads];
  if (downloads.some(([, report]) => !isFinished(report))) {
    const loaded = downloads.reduce((sum, [, report]) => sum + report.loaded, 0);
    const totals = downloads.map(([file, report]) => totalOf(file, report));
    if (totals.includes(null)) return `Downloading · ${formatBytes(loaded)}`;
    const total = totals.reduce((sum, value) => sum + value, 0);
    return `Downloading · ${Math.floor((100 * loaded) / total)}%`;
  }
  return progress.loadingIntoMemory ? 'Loading into memory…' : null;
}

function renderStatus() {
  const engineStatus = statusOfEngine();
  element('status').dataset.kind = engineStatus ? 'busy' : status.kind;
  element('status-label').textContent = engineStatus ?? status.label;
}

function renderProgress() {
  renderStatus();
  const list = element('downloads');
  list.replaceChildren(...[...progress.downloads].map(([file, report]) => {
    const { stage, loaded } = report;
    const knownTotal = totalOf(file, report);
    const finished = isFinished(report);
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${STAGE_LABELS[stage]}: ${fileNameOf(file)}`;
    name.title = file;
    const bar = document.createElement('div');
    bar.className = `bar${knownTotal ? '' : ' indeterminate'}${finished ? ' done' : ''}`;
    const fill = document.createElement('span');
    if (knownTotal) fill.style.width = `${Math.min(100, (100 * loaded) / knownTotal)}%`;
    bar.append(fill);
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = knownTotal ? `${formatBytes(loaded)} / ${formatBytes(knownTotal)}` : formatBytes(loaded);
    row.append(name, bar, size);
    return row;
  }));

  const run = progress.run;
  element('run').hidden = run === null;
  if (run) {
    element('run-detail').textContent = run.filesRead
      ? `${run.filesRead} files read (${formatBytes(run.bytesRead)}) · ${fileNameOf(run.file)}`
      : 'TeX reads the files of the bundles from memory; other files show here.';
  }
}

function onProgress(report) {
  switch (report.stage) {
    case 'engine':
    case 'index':
    case 'bundle':
      if (progress.downloadsFinished) {
        progress.downloads.clear();
        progress.downloadsFinished = false;
      }
      progress.downloads.set(report.file, report);
      if (report.stage !== 'index' && isFinished(report)) progress.loadingIntoMemory = true;
      // Only index files: findScope() or setScope().
      setPhase([...progress.downloads.values()].every(({ stage }) => stage === 'index') && !progress.loadingIntoMemory
        ? 'Downloading an index…' : 'Downloading the engine and the TeX files…');
      break;
    case 'files':
      progress.downloadsFinished = true;
      progress.loadingIntoMemory = true;
      setPhase('Loading the engine and the TeX files into memory…');
      break;
    case 'started':
      progress.loadingIntoMemory = false;
      if (compiling) setPhase('Compiling…');
      break;
    case 'run':
      if (progress.downloadsFinished) progress.downloads.clear();
      progress.run = report;
      setPhase('Running TeX…');
      break;
  }
  scheduleRender();
}

const tex = createTexEngine({
  baseUrl: new URL('./', import.meta.url).href,
  createWorker: () => new Worker(new URL('./js/worker.js', import.meta.url)),
  scope: MEDIUM,
  bundles: BUNDLES,
  onProgress,
});

// The log of the page: the engine start, and each step of each compile. It
// keeps the last MAX_LOG_LINES lines. kind: 'heading' or 'failure', else
// null.
const MAX_LOG_LINES = 300;
function addLog(text, kind = null) {
  const log = element('log');
  const line = document.createElement('li');
  if (kind) line.className = kind;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString();
  line.append(time, ' ', text);
  log.append(line);
  while (log.children.length > MAX_LOG_LINES) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

// The first line of an error, for the status and the phase. The log has all
// of it.
const firstLineOf = (error) => String(error).split('\n')[0];

function showErrors(errors) {
  element('errors').replaceChildren(...errors.map(({ message, line, context }) => {
    const item = document.createElement('li');
    if (line !== null) {
      const jump = document.createElement('button');
      jump.textContent = `line ${line}`;
      jump.title = 'Select this line in the document';
      jump.addEventListener('click', () => selectLine(line));
      item.append(jump);
    }
    item.append(message + (context ? `\n${context}` : ''));
    return item;
  }));
}

function selectLine(lineNumber) {
  const lines = sourceInput.value.split('\n');
  const start = lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0);
  sourceInput.focus();
  sourceInput.setSelectionRange(start, start + (lines[lineNumber - 1] ?? '').length);
}

// The PDF, drawn with PDF.js (pdfjs/, from pages/default.nix): one canvas for
// each page, as wide as the frame, so that the preview is as tall as its
// pages. A browser's own PDF viewer in an iframe cannot do this, and Android
// Chrome does not show a PDF in an iframe. PDF.js loads at the first PDF.
let pdfjs = null;
let pdfDocument = null;
let pdfUrl = null;
// The last showPdf() and the last renderPdf(): an older one stops.
let pdfGeneration = 0;
let renderGeneration = 0;
let renderedWidth = 0;
// The largest zoom, for a small picture (for example of the standalone class).
const MAX_PDF_SCALE = 3;

function loadPdfjs() {
  pdfjs ??= import('./pdfjs/pdf.min.mjs').then((library) => {
    library.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    return library;
  }, (error) => {
    pdfjs = null;
    throw error;
  });
  return pdfjs;
}

async function showPdf(bytes) {
  const generation = ++pdfGeneration;
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  element('pdf-download').href = pdfUrl;
  element('pdf-download').hidden = false;
  try {
    const library = await loadPdfjs();
    // PDF.js moves the buffer to its worker, so it gets a copy.
    const nextDocument = await library.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    if (generation !== pdfGeneration) {
      nextDocument.destroy();
      return;
    }
    pdfDocument?.destroy();
    pdfDocument = nextDocument;
    await renderPdf();
  } catch (error) {
    if (generation === pdfGeneration) addLog(`The PDF did not show: ${error}. "Download PDF" has it.`, 'failure');
  }
}

// The width for the pages: the inside of the frame.
function pdfWidth() {
  const style = getComputedStyle(element('pdf'));
  return element('pdf').parentElement.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

// Draw all pages, then show them together, so that a new PDF does not
// flicker.
async function renderPdf() {
  const generation = ++renderGeneration;
  const pdf = pdfDocument;
  const container = element('pdf');
  const width = pdfWidth();
  const canvases = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const scale = Math.min(MAX_PDF_SCALE, width / page.getViewport({ scale: 1 }).width);
    const viewport = page.getViewport({ scale: scale * devicePixelRatio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / devicePixelRatio)}px`;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    if (generation !== renderGeneration) return;
    canvases.push(canvas);
  }
  renderedWidth = width;
  container.replaceChildren(...canvases);
  container.hidden = false;
  element('pdf-empty').hidden = true;
}

// Draw again when the width of the frame changes.
let resizeTimeout = null;
new ResizeObserver(() => {
  if (!pdfDocument || element('pdf').parentElement.clientWidth === 0) return;
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (Math.abs(pdfWidth() - renderedWidth) >= 1) renderPdf().catch((error) => addLog(`The PDF did not show: ${error}`, 'failure'));
  }, 150);
}).observe(element('pdf').parentElement);

// The timer in the status, while the page waits for the engine.
function startTimer(startTime) {
  clearInterval(timerInterval);
  const timer = element('timer');
  const show = () => { timer.textContent = formatSeconds(performance.now() - startTime); };
  show();
  timer.hidden = false;
  timerInterval = setInterval(show, 100);
}

function stopTimer() {
  clearInterval(timerInterval);
  element('timer').hidden = true;
}

// The first start, so that the first compile does not wait for it.
startTimer(performance.now());
tex.start().then((started) => {
  progress.downloadsFinished = true;
  progress.loadingIntoMemory = false;
  progress.downloads.clear();
  scheduleRender();
  addLog(`The engine started in ${formatSeconds(started.timings.totalMs)}.`);
  if (compiling) return;
  stopTimer();
  setStatus('ready', `Ready · ${formatSeconds(started.timings.totalMs)}`);
  setPhase(`The engine started in ${formatSeconds(started.timings.totalMs)}.`);
}, (error) => {
  progress.loadingIntoMemory = false;
  addLog(`The engine did not start: ${error}`, 'failure');
  if (compiling) return;
  stopTimer();
  setStatus('error', 'The engine did not start');
  setPhase(firstLineOf(error));
});

// The loop of library/README.md: install the packages of a `needs` result,
// or change to a larger scope, and compile again. The result is
// { kind, label, phase, errors } for the status, or null after stop().
async function compileRounds(source) {
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    setStatus('busy', round === 1 ? 'Compiling…' : `Compiling (round ${round})…`);
    setPhase(round === 1 ? 'Compiling…' : `Compiling again (round ${round})…`);
    progress.run = null;
    scheduleRender();
    const result = await tex.compile(source);
    if (result.status === 'stopped') return null;
    if (result.status === 'ok') {
      showPdf(result.pdf);
      addLog(`round ${round}: ok in ${formatSeconds(result.runMs)}, ${result.filesLoaded} files read (${formatBytes(result.bytesLoaded)})`);
      return { kind: 'ready', label: 'Done', phase: 'The PDF is ready.' };
    }
    if (result.status === 'timeout') {
      addLog(`round ${round}: no result after ${formatSeconds(result.timeoutMs)}, so the engine was stopped`);
      return { kind: 'error', label: 'Timed out', phase: `No result after ${formatSeconds(result.timeoutMs)}. The next compile starts a new engine.` };
    }
    if (result.status === 'crashed') {
      addLog(`round ${round}: the engine stopped: ${result.message}`);
      return { kind: 'error', label: 'The engine crashed', phase: firstLineOf(result.message) };
    }
    if (result.status === 'needs' && result.packages.length) {
      const names = result.packages.map(({ name }) => name);
      if (tex.scope.length > MEDIUM.length) {
        addLog(`round ${round}: needs ${names.join(', ')}, which this site does not have`);
        return { kind: 'warning', label: 'Packages not on this site',
          phase: 'This site has only the packages of the medium scope. A real app downloads the packages that a document needs.' };
      }
      // A real app downloads, checks and unpacks each archive here. This
      // site has the packages of the medium scope already.
      addLog(`round ${round}: install ${names.join(', ')}`);
      setPhase(`Installing ${names.join(', ')}…`);
      await tex.packagesInstalled(names);
      continue;
    }
    if (result.status === 'needs' && result.files.length) {
      setPhase(`Looking for ${result.files.join(', ')} in a larger scope…`);
      const found = await tex.findScope(result.files, [MEDIUM, FULL]);
      if (found.scope) {
        addLog(`round ${round}: ${result.files.join(', ')} is in the full scope, so change to it`);
        setPhase('Changing to the full scope…');
        await tex.setScope(found.scope);
        continue;
      }
      addLog(`round ${round}: no scope has ${found.files.join(', ')}`);
    }
    addLog(`round ${round}: ${result.errors.length} errors`);
    return { kind: 'error', label: 'Errors', phase: 'TeX found errors in the document.', errors: result.errors };
  }
  addLog(`stopped after ${MAX_ROUNDS} rounds`);
  return { kind: 'error', label: 'Too many rounds', phase: `The document still needs more after ${MAX_ROUNDS} rounds.` };
}

async function compile() {
  if (compiling) return;
  compiling = true;
  stopRequested = false;
  compileButton.disabled = true;
  stopButton.disabled = false;
  compileCount++;
  addLog(`Compile ${compileCount}`, 'heading');
  const startTime = performance.now();
  startTimer(startTime);
  let outcome;
  try {
    outcome = await compileRounds(sourceInput.value);
  } catch (error) {
    // stop() rejects the operations other than a compile.
    if (stopRequested) {
      outcome = null;
    } else {
      addLog(`failed: ${error}`, 'failure');
      outcome = { kind: 'error', label: 'Failed', phase: firstLineOf(error) };
    }
  }
  const elapsed = formatSeconds(performance.now() - startTime);
  if (outcome === null) {
    addLog(`stopped after ${elapsed}`);
    outcome = { kind: 'stopped', label: 'Stopped', phase: 'Stopped. The next compile starts a new engine.' };
  }
  // The errors of the last result only.
  showErrors(outcome.errors ?? []);
  setPhase(outcome.phase);
  setStatus(outcome.kind, `${outcome.label} · ${elapsed}`);
  stopTimer();
  progress.run = null;
  // Also the downloads of a start that stop() ended.
  progress.downloads.clear();
  progress.downloadsFinished = true;
  progress.loadingIntoMemory = false;
  scheduleRender();
  compiling = false;
  compileButton.disabled = false;
  stopButton.disabled = true;
}

compileButton.addEventListener('click', compile);
stopButton.addEventListener('click', () => {
  if (!compiling) return;
  stopRequested = true;
  stopButton.disabled = true;
  // TeX runs synchronously in the worker, so stop() stops the worker.
  tex.stop();
});
sourceInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    compile();
  }
});

// The example page: compile the document of the text area, and show the PDF.
// It shows the loop that an app runs around compile() (library/README.md):
// install the packages of a `needs` result, or change to a larger scope, and
// compile again.
//
// The paths are relative to this file, so that the page also works below a
// path, for example on GitHub Pages.
import { createTexEngine } from './js/client.js';

// The example app's scopes, smallest first, and its bundles, lazytex's first.
const MEDIUM = ['index/index-medium.json'];
const FULL = ['index/index-medium.json', 'index/index-full-extra.json'];
const BUNDLES = ['bundle.tar', 'bundle-example.tar'];

// site.json is only on the GitHub Pages site (nix build .#example-pages).
// That site has only the packages of the medium scope.
const site = await fetch('site.json').then((response) => (response.ok ? response.json() : {}), () => ({}));

const status = document.getElementById('status');
const say = (text) => { status.textContent = text; };

const tex = createTexEngine({
  baseUrl: new URL('./', import.meta.url).href,
  createWorker: () => new Worker(new URL('./js/worker.js', import.meta.url)),
  scope: MEDIUM,
  bundles: BUNDLES,
  onProgress: ({ stage }) => say(`Starting the engine: ${stage}…`),
});
tex.start().then((started) => say(`Ready in ${Math.round(started.timings.totalMs)} ms.`), (error) => say(String(error)));

async function compile() {
  const source = document.getElementById('source').value;
  const log = [];
  for (let round = 0; round < 10; round++) {
    const result = await tex.compile(source);
    if (result.status === 'ok') {
      document.getElementById('pdf').src = URL.createObjectURL(new Blob([result.pdf], { type: 'application/pdf' }));
      log.push(`ok: ${Math.round(result.runMs)} ms, ${result.filesLoaded} files loaded`);
      return say(log.join('\n'));
    }
    if (result.status === 'needs' && result.packages.length) {
      const names = result.packages.map(({ name }) => name);
      if (site.mediumOnly && tex.scope.length > MEDIUM.length) {
        log.push(`not on this site: ${names.join(', ')}. It has only the packages of the medium scope.`,
          'A real app downloads them (example/README.md, "Install packages in a browser").');
        return say(log.join('\n'));
      }
      // A real app downloads, checks and unpacks each archive here
      // (example/README.md). This site has the packages already.
      log.push(`install: ${names.join(', ')}`);
      await tex.packagesInstalled(names);
      continue;
    }
    if (result.status === 'needs' && result.files.length) {
      const found = await tex.findScope(result.files, [MEDIUM, FULL]);
      if (found.scope) {
        log.push(`change to the scope ${found.scope.join(' + ')}`);
        await tex.setScope(found.scope);
        continue;
      }
      log.push(`no scope has ${found.files.join(', ')}`);
    }
    log.push(`${result.status}: ${JSON.stringify(result.errors ?? result, null, 1)}`);
    return say(log.join('\n'));
  }
  say(log.concat('too many rounds').join('\n'));
}

document.getElementById('compile').addEventListener('click', () => compile().catch((error) => say(String(error))));

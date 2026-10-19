// A stand-in for an app's package cache, for the Node tests. It serves the
// files of installed packages and the generated files. It never installs a
// package during a request: install() does that between compiles, as an app
// does (docs/formats.md, "When a compile needs packages").
//
// Where an install comes from:
//   'release'  the package has a releaseArchive: the archive from the release
//              is checked against its SHA-512 and unpacked with tar. The tests
//              do not download: the file with the URL's asset name comes from
//              archives/ on the site (the app site has the archives of both
//              releases)
//   'mirror'   any other package. The tests have no network, so the files come
//              from the full tree on the site, as if downloaded and unpacked.
//              (tools/check_mirror_download.py tests real downloads.)
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createPackageSource({ site, scope }) {
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'package-cache-'));
  const installed = new Map();
  const installs = [];
  const requests = [];
  // Requests for files of packages that are not installed. The engine must never make one.
  const unexpectedRequests = [];

  // The release's copy of a release asset, by its asset name.
  function localArchive(url) {
    const assetName = url.slice(url.lastIndexOf('/') + 1);
    for (const directory of ['archives/hosted', 'archives']) {
      const candidate = path.join(site, directory, assetName);
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(`no archive ${assetName} on the site`);
  }

  function install(names) {
    for (const name of names) {
      if (installed.has(name)) continue;
      const packageEntry = scope.packages.get(name);
      if (!packageEntry) throw new Error(`install: ${name} is not in the scope`);
      const startTime = performance.now();
      const archive = packageEntry.releaseArchive;
      if (archive) {
        const archivePath = localArchive(archive.url);
        const sha512 = crypto.createHash('sha512').update(fs.readFileSync(archivePath)).digest('hex');
        if (sha512 !== archive.sha512) throw new Error(`${name}: SHA-512 of ${archive.url} does not match the index`);
        // Archives hold paths relative to texmf-dist, as TeX Live's do.
        fs.mkdirSync(path.join(cacheDirectory, 'texmf-dist'), { recursive: true });
        const result = childProcess.spawnSync('tar', ['-xJf', archivePath, '-C', path.join(cacheDirectory, 'texmf-dist')]);
        if (result.status !== 0) throw new Error(`tar failed for ${name}: ${result.stderr}`);
      }
      installed.set(name, archive ? 'release' : 'mirror');
      installs.push({ name, source: installed.get(name), bytes: archive ? archive.bytes : packageEntry.archiveBytes, ms: performance.now() - startTime });
    }
  }

  // fetchSync for createEngine: url is the site path of the file.
  function fetchSync(url) {
    const urlPath = path.relative(site, url);
    requests.push(urlPath);
    const file = scope.fileAt('/' + urlPath);
    if (!file || file.packageName === null) return new Uint8Array(fs.readFileSync(url)); // generated file
    const source = installed.get(file.packageName);
    if (!source) {
      unexpectedRequests.push(urlPath);
      throw new Error(`request for ${urlPath}, but ${file.packageName} is not installed`);
    }
    if (source === 'release') {
      const distRoot = scope.indexes[0].trees['texmf-dist'];
      return new Uint8Array(fs.readFileSync(path.join(cacheDirectory, 'texmf-dist', ('/' + urlPath).slice(distRoot.length + 1))));
    }
    return new Uint8Array(fs.readFileSync(url));
  }

  return {
    fetchSync,
    install,
    installed: () => [...installed.keys()],
    installs,
    requests,
    unexpectedRequests,
    remove: () => fs.rmSync(cacheDirectory, { recursive: true, force: true }),
  };
}

module.exports = { createPackageSource };

'use strict';
// Which files does the gate judge? Derived from the Postman project and the config file, for the CI "changes"
// job: the gate runs only when one of them changed.
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const posix = (p) => p.split(path.sep).join('/');

/** Repo-relative paths of a file or folder: as declared, and where a symlink really points (git sees the target). */
function variants(cwd, rel) {
  const abs = path.resolve(cwd, rel);
  const out = [posix(path.relative(cwd, abs))];
  try {
    const real = path.relative(fs.realpathSync(cwd), fs.realpathSync(abs));
    if (real && !real.startsWith('..')) out.push(posix(real));
  } catch { /* missing: only the declared path */ }
  const isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
  return out.map((p) => (isDir ? p.replace(/\/?$/, '/') : p));
}

/** ERE matching the repo-relative paths that make the gate relevant. */
function relevantRegex(cwd, ctx) {
  const { file } = loadConfig(cwd, ctx.configFile);
  const items = ['.postman/'];
  if (file) items.push(posix(file));
  else items.push('quality-gate.yml');
  if (ctx.spec) items.push(...variants(cwd, ctx.spec.path));
  if (ctx.collection) items.push(...variants(cwd, ctx.collection.path));
  return `^(${[...new Set(items)].map(esc).join('|')})`;
}

module.exports = { relevantRegex };

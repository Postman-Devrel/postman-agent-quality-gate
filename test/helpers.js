'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const sample = (name) => fs.readFileSync(path.join(__dirname, 'samples', name), 'utf8');
const fixture = (name) => path.join(__dirname, '..', 'fixtures', name);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pqg-test-'));

/** Writes { 'rel/path': 'content' } under a new temp dir and returns it. */
function project(files) {
  const dir = tmp();
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** A fake exec: `script` is a function (cmd, args) -> {status, stdout, stderr} | undefined. Records the calls. */
function fakeExec(script) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const r = script(cmd, args) || {};
    return { status: 0, stdout: '', stderr: '', error: null, ...r };
  };
  exec.calls = calls;
  return exec;
}

const cliEnabled = process.env.PQG_CLI_TESTS === '1';
module.exports = { sample, fixture, tmp, project, fakeExec, cliEnabled };

'use strict';
// Thin wrapper around child_process so steps can be tested with a fake `exec`.
const { spawnSync } = require('child_process');

/**
 * @returns {{status:number|null, stdout:string, stderr:string, error:Error|null}}
 * Never throws. status is null when the process could not start or timed out.
 */
function exec(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    encoding: 'utf8',
    timeout: opts.timeout || 10 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
    input: opts.input,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

/** Renders a command for the report (quotes only what needs it). */
function render(cmd, args) {
  return [cmd, ...args].map((a) => (/[\s"'{}<>]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

module.exports = { exec, render };

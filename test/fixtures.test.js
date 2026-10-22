'use strict';
// Fixtures end to end. The tests that really call the Postman CLI are opt-in: PQG_CLI_TESTS=1 npm test.
// They only use local files and a local mock (never a real API server).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildContext, runSteps, runStep } = require('../core/runner');
const { aggregate } = require('../core/aggregate');
const { fixture, fakeExec, tmp, project, cliEnabled } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'postman-agent-quality-gate.js');
const ctxFor = (name, exec) => buildContext({ cwd: fixture(name), resultsDir: tmp(), overrides: exec ? { exec, log() {} } : { log() {} } });
const cli = (args, cwd) => spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8' });

test('unsupported-spec (AsyncAPI): every spec step is not_available with the reason, required ones block', () => {
  const ctx = ctxFor('unsupported-spec', fakeExec(() => ({ stdout: '1.76.0\n' })));
  assert.equal(ctx.spec.type, 'asyncapi');
  const { results } = runSteps(ctx, ctx.config.steps.filter((s) => s !== 'skills-check'));
  for (const r of results) {
    assert.equal(r.status, 'not_available', r.step);
    assert.match(r.summary, /spec type "asyncapi" is not supported by/);
  }
  const byId = Object.fromEntries(results.map((r) => [r.step, r]));
  const { report } = aggregate(ctx.config, byId, { spec: ctx.spec });
  assert.equal(report.passed, false);
  assert.ok(report.blockers.some((b) => /Required step contract-lint is not available/.test(b)));
  assert.deepEqual(report.spec, { path: 'orders.asyncapi.yaml', type: 'asyncapi' });
});

test('a step that crashes becomes not_available, never an exception', () => {
  const ctx = ctxFor('green', fakeExec(() => { throw new Error('boom'); }));
  const r = runStep(ctx, 'contract-lint', { write: false, version: '1.76.0' });
  assert.equal(r.status, 'not_available');
  assert.match(r.summary, /step crashed: boom/);
});

test('missing postman CLI: CLI steps are not_available, coverage still runs', () => {
  const ctx = ctxFor('green', fakeExec(() => ({ status: null, error: new Error('ENOENT') })));
  const { results } = runSteps(ctx, ['contract-lint', 'coverage']);
  assert.match(results[0].summary, /postman CLI not installed/);
  assert.equal(results[1].status, 'pass');
});

test('coverage on fixtures needs no CLI', () => {
  for (const name of ['green', 'lint-error', 'breaking-change']) {
    const r = runStep(ctxFor(name), 'coverage', { write: false });
    assert.equal(r.status, 'pass', name);
    assert.equal(r.score, 100);
  }
});

test('bin: unsupported-spec fails with exit 1, bad config exits 2, --no-exit-code exits 0', () => {
  const dir = fixture('unsupported-spec');
  const out = tmp();
  const failed = cli(['run', '--results-dir', out], dir);
  assert.equal(failed.status, 1);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.passed, false);
  assert.equal(report.schema_version, 1);
  assert.equal(cli(['aggregate', '--results-dir', out, '--no-exit-code'], dir).status, 0);

  const bad = project({ 'quality-gate.yml': 'pass_rating: Z\n' });
  const r = cli(['run', 'coverage'], bad);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Configuration error[\s\S]*pass_rating/);

  const many = project({ '.postman/resources.yaml': 'cloudResources:\n  specs:\n    ../a.yaml: 1\n    ../b.yaml: 2\n', 'a.yaml': 'openapi: 3.0.0', 'b.yaml': 'openapi: 3.0.0' });
  const m = cli(['run', 'coverage'], many);
  assert.equal(m.status, 2);
  assert.match(m.stderr, /declares 2 specs/);
  assert.equal(cli(['run', 'nope'], many).status, 2);
});

// ---- opt-in: the real Postman CLI -----------------------------------------------------------------------------
const real = { skip: cliEnabled ? false : 'set PQG_CLI_TESTS=1 to call the Postman CLI' };

test('CLI: green fixture, lint/tests/coverage/ai-readiness all pass', real, () => {
  const ctx = ctxFor('green');
  const { results } = runSteps(ctx, ['contract-lint', 'contract-tests', 'coverage', 'ai-readiness']);
  assert.deepEqual(results.map((r) => r.status), ['pass', 'pass', 'pass', 'pass'], JSON.stringify(results.map((r) => r.summary)));
});

test('CLI: lint-error fixture fails contract-lint and blocks', real, () => {
  const ctx = ctxFor('lint-error');
  const r = runStep(ctx, 'contract-lint', { write: false, version: '1' });
  assert.equal(r.status, 'fail');
  const { report } = aggregate(ctx.config, { 'contract-lint': r, 'contract-tests': { step: 'contract-tests', status: 'pass', score: 100, details: [] } }, {});
  assert.equal(report.passed, false);
});

test('CLI: breaking-change fixture fails contract-tests (collection expects the old field)', real, () => {
  const r = runStep(ctxFor('breaking-change'), 'contract-tests', { write: false, version: '1' });
  assert.equal(r.status, 'fail');
  assert.ok(r.details.some((d) => d.check === 'failure'));
});

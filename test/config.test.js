'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig, loadConfig, ConfigError, DEFAULTS } = require('../core/config');
const { project } = require('./helpers');

test('defaults when the config is empty', () => {
  const c = validateConfig({});
  assert.deepEqual(c.required_steps, ['contract-lint', 'contract-tests']);
  assert.equal(c.pass_rating, 'B');
  assert.equal(c.impact.api, null);
  assert.deepEqual(c.blockers, DEFAULTS.blockers);
  assert.equal(Object.values(c.weights).reduce((a, b) => a + b, 0), 100);
});

test('overrides are merged over the defaults', () => {
  const c = validateConfig({ spec: 'a.yaml', impact: { api: 'x' }, weights: { impact: 5 }, rating: { A: 95 }, pass_rating: 'C' });
  assert.equal(c.spec, 'a.yaml');
  assert.equal(c.impact.api, 'x');
  assert.equal(c.weights.impact, 5);
  assert.equal(c.weights['contract-lint'], 25);
  assert.equal(c.rating.A, 95);
  assert.equal(c.pass_rating, 'C');
});

test('reports every problem at once with a clear message', () => {
  assert.throws(
    () => validateConfig({ nope: 1, steps: ['lint'], weights: { impact: 'x' }, pass_rating: 'Z', blockers: { impact: 'sometimes' }, ai_readiness: { pass_min: 150 } }),
    (e) => e instanceof ConfigError && e.errors.length === 6 && /unknown key "nope"/.test(e.errors[0]),
  );
});

test('required and blocker steps must be enabled', () => {
  assert.throws(() => validateConfig({ steps: ['coverage'] }), (e) => e.errors.some((m) => /required_steps.*contract-lint.*not in "steps"/.test(m)));
  assert.doesNotThrow(() => validateConfig({ steps: ['coverage'], required_steps: [], blockers: {} }));
});

test('rating thresholds must decrease', () => {
  assert.throws(() => validateConfig({ rating: { A: 10 } }), (e) => /decrease/.test(e.errors[0]));
});

test('the mock port is not a config key anymore', () => {
  assert.throws(() => validateConfig({ mock: { port: 4010 } }), (e) => /unknown key "mock"/.test(e.errors[0]));
});

test('loadConfig: optional default file, explicit file must exist, bad YAML is reported', () => {
  const none = project({});
  assert.equal(loadConfig(none).file, null);
  assert.throws(() => loadConfig(none, 'other.yml'), /not found/);
  const ok = project({ 'quality-gate.yml': 'impact:\n  api: svc\n' });
  assert.equal(loadConfig(ok).config.impact.api, 'svc');
  const bad = project({ 'quality-gate.yml': 'a: [1,' });
  assert.throws(() => loadConfig(bad), /not valid YAML/);
});

test('contract-lint.exceptions: valid entries are kept, default is empty', () => {
  assert.deepEqual(validateConfig({})['contract-lint'], { exceptions: [] });
  const ex = { path: 'paths./a/', issue: 'trailing slash', reason: 'Real route' };
  assert.deepEqual(validateConfig({ 'contract-lint': { exceptions: [ex] } })['contract-lint'].exceptions, [ex]);
});

test('contract-lint.exceptions: path, issue and a non-empty reason are required; unknown keys rejected', () => {
  const errs = (cfg) => { try { validateConfig(cfg); return []; } catch (e) { return e.errors; } };
  assert.equal(errs({ 'contract-lint': { exceptions: [{ path: 'p', issue: 'i' }] } }).length, 1);
  assert.match(errs({ 'contract-lint': { exceptions: [{ path: 'p', issue: 'i', reason: '  ' }] } })[0], /reason.*required/);
  assert.equal(errs({ 'contract-lint': { exceptions: [{ issue: 'i', reason: 'r' }] } }).length, 1);
  assert.match(errs({ 'contract-lint': { exceptions: [{ path: 'p', issue: 'i', reason: 'r', why: 'x' }] } })[0], /unknown key/);
  assert.match(errs({ 'contract-lint': { exceptions: 'nope' } })[0], /must be a list/);
  assert.match(errs({ 'contract-lint': { rules: [] } })[0], /unknown key "contract-lint.rules"/);
  assert.match(errs({ 'contract-lint': { exceptions: ['x'] } })[0], /must be a mapping/);
});

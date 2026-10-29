'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregate, ratingFor } = require('../core/aggregate');
const { validateConfig } = require('../core/config');

const step = (s, status, score, details = []) => ({ step: s, status, score, summary: `${s} ${status}`, details, command: '' });
const na = (s) => step(s, 'not_available', null);
const green = () => ({
  'skills-check': step('skills-check', 'pass', 100),
  'contract-lint': step('contract-lint', 'pass', 100),
  'contract-tests': step('contract-tests', 'pass', 100),
  coverage: step('coverage', 'pass', 100),
  'ai-readiness': step('ai-readiness', 'pass', 100),
  impact: step('impact', 'pass', 100),
});
const run = (over = {}, cfg = {}) => aggregate(validateConfig(cfg), { ...green(), ...over }, {});

test('all green: A 100, passed, report keeps the fields the mod and reviewer read', () => {
  const { report, markdown } = run();
  assert.equal(report.passed, true);
  assert.equal(report.score, 100);
  assert.equal(report.rating, 'A');
  assert.deepEqual(report.blockers, []);
  assert.equal(report.schema_version, 1);
  assert.ok(report.gate_version);
  assert.deepEqual(report.steps[0], { step: 'skills-check', status: 'pass', score: 100 });
  assert.ok(Array.isArray(report.feedback));
  assert.ok(markdown.startsWith('<!-- healthcare-api-quality-gate -->'));
});

test('weighted score and ratings', () => {
  const { report } = run({ 'ai-readiness': step('ai-readiness', 'warn', 70) });
  assert.equal(report.score, 94); // 100 - 30 * 20 / 100
  assert.equal(report.rating, 'A');
  assert.equal(ratingFor(validateConfig({}), 49), 'E');
  assert.equal(ratingFor(validateConfig({}), 50), 'D');
  assert.equal(ratingFor(validateConfig({}), 80), 'B');
});

test('rating below pass_rating fails without any blocker', () => {
  const { report } = run({ 'ai-readiness': step('ai-readiness', 'warn', 0), 'skills-check': step('skills-check', 'warn', 0), impact: step('impact', 'warn', 0), coverage: step('coverage', 'warn', 0) });
  assert.equal(report.rating, 'E'); // 45
  assert.deepEqual(report.blockers, []);
  assert.equal(report.passed, false);
});

test('feedback comes from warn and fail steps, with hints', () => {
  const { report } = run({ coverage: step('coverage', 'warn', 66, [{ result: 'GET /x', hint: 'add it' }]) });
  assert.deepEqual(report.feedback, [{ step: 'coverage', status: 'warn', finding: 'GET /x', fix: 'add it' }]);
});

test('blocker on_fail: a failing contract-lint blocks whatever the score', () => {
  const { report } = run({ 'contract-lint': step('contract-lint', 'fail', 60) });
  assert.equal(report.passed, false);
  assert.match(report.blockers[0], /contract-lint failed/);
  assert.ok(report.score >= 80);
});

test('blocker on_breaking: a breaking consumer detail blocks, a non breaking one does not', () => {
  assert.equal(run({ impact: step('impact', 'fail', 0, [{ check: 'consumer', breaking: true }]) }).report.passed, false);
  assert.equal(run({ impact: step('impact', 'pass', 100, [{ check: 'consumer', breaking: false }]) }).report.passed, true);
});

test('blockers are declared in the config, not hard-coded', () => {
  const failing = { coverage: step('coverage', 'fail', 0) };
  assert.equal(run(failing).report.blockers.length, 0);
  assert.equal(run(failing, { blockers: { coverage: 'on_fail' } }).report.passed, false);
  assert.equal(run({ coverage: step('coverage', 'warn', 50) }, { blockers: { coverage: 'on_warn' } }).report.passed, false);
  // contract-lint is not a blocker once the config drops it
  assert.equal(run({ 'contract-lint': step('contract-lint', 'fail', 60) }, { blockers: {} }).report.blockers.length, 0);
});

test('required_steps: a required step not_available is a blocker, an optional one is not', () => {
  const req = run({ 'contract-tests': na('contract-tests') });
  assert.equal(req.report.passed, false);
  assert.match(req.report.blockers[0], /Required step contract-tests is not available/);
  assert.equal(run({ impact: na('impact'), 'skills-check': na('skills-check') }).report.passed, true);
  assert.equal(run({ 'contract-tests': na('contract-tests') }, { required_steps: [], blockers: {} }).report.passed, true);
});

test('a required step not_available caps the rating at E and the headline says why', () => {
  const only = { 'skills-check': step('skills-check', 'pass', 100) };
  const r = aggregate(validateConfig({}), only, {});
  assert.equal(r.report.score, 100);
  assert.equal(r.report.rating, 'E');
  assert.equal(r.report.passed, false);
  assert.match(r.report.headline, /rating E, required steps contract-lint, contract-tests did not run \(100\/100 on the steps that ran\)/);
  assert.match(r.markdown, /## ❌ Postman agent quality gate: rating E, required steps contract-lint, contract-tests did not run/);
  assert.doesNotMatch(r.markdown, /rating A/);
  const one = run({ 'contract-tests': na('contract-tests') });
  assert.equal(one.report.rating, 'E');
  assert.match(one.report.headline, /required step contract-tests did not run/);
  // an optional step not_available leaves the rating alone
  const opt = run({ impact: na('impact') });
  assert.equal(opt.report.rating, 'A');
  assert.equal(opt.report.headline, null);
  assert.match(opt.markdown, /rating A \(100\/100\)/);
});

test('not_available steps are excluded and the weights re-normalized', () => {
  const { report } = run({ impact: na('impact'), 'ai-readiness': step('ai-readiness', 'fail', 0) });
  // weights left: 10 + 25 + 20 + 5 + 20 (ai-readiness, score 0) = 80; the ai-readiness 20 contributes 0
  assert.equal(report.score, Math.round((60 * 100) / 80));
});

test('a step that never ran counts as not_available, nothing usable is a blocker', () => {
  const r = aggregate(validateConfig({}), {}, {});
  assert.equal(r.report.passed, false);
  assert.ok(r.report.blockers.includes('No step produced a usable result'));
  assert.equal(r.report.rating, 'E');
});

test('disabled steps are left out of the report', () => {
  const { report } = run({}, { steps: ['contract-lint', 'contract-tests'], blockers: {} });
  assert.deepEqual(report.steps.map((s) => s.step), ['contract-lint', 'contract-tests']);
});

test('meta: spec, collection and cli version land in the report', () => {
  const { report } = aggregate(validateConfig({}), green(), { spec: { path: 's.yaml', type: 'openapi-3', abs: '/x' }, collection: { path: 'c' }, cli_version: '1.76.0' });
  assert.deepEqual(report.spec, { path: 's.yaml', type: 'openapi-3' });
  assert.deepEqual(report.collection, { path: 'c' });
  assert.equal(report.cli_version, '1.76.0');
});

const { applyDegraded } = require('../core/step-result');

test('degraded: pass becomes warn, the score is capped, a fail stays a fail, not_available is untouched', () => {
  assert.deepEqual([applyDegraded({ status: 'pass', score: 100, degraded: 'x' })].map((r) => [r.status, r.score])[0], ['warn', 70]);
  assert.deepEqual([applyDegraded({ status: 'warn', score: 40, degraded: 'x' })].map((r) => [r.status, r.score])[0], ['warn', 40]);
  assert.deepEqual([applyDegraded({ status: 'fail', score: 10, degraded: 'x' })].map((r) => [r.status, r.score])[0], ['fail', 10]);
  assert.equal(applyDegraded({ status: 'not_available', score: null, degraded: 'x' }).status, 'not_available');
  assert.equal(applyDegraded({ status: 'pass', score: 100 }).status, 'pass');
});

test('degraded: even a result file that says pass 100 is capped by the aggregation, and reported', () => {
  const { report, markdown } = run({ 'contract-lint': { ...step('contract-lint', 'pass', 100), degraded: 'governance rules skipped' } });
  assert.deepEqual(report.steps.find((s) => s.step === 'contract-lint'), { step: 'contract-lint', status: 'warn', score: 70, degraded: 'governance rules skipped' });
  assert.ok(report.score < 100);
  assert.ok(report.feedback.some((f) => f.step === 'contract-lint' && /degraded/.test(f.finding)));
  assert.match(markdown, /### Degraded[\s\S]*contract-lint.*governance rules skipped/);
  assert.doesNotMatch(run().markdown, /### Degraded/);
});

test('degraded required step still counts as run (no blocker); its syntax error still blocks', () => {
  const ok = run({ 'contract-lint': { ...step('contract-lint', 'pass', 100), degraded: 'x' } });
  assert.deepEqual(ok.report.blockers, []);
  assert.equal(ok.report.passed, true);
  const bad = run({ 'contract-lint': { ...step('contract-lint', 'fail', 10), degraded: 'x' } });
  assert.equal(bad.report.passed, false);
  assert.match(bad.report.blockers[0], /contract-lint failed/);
});

test('accepted lint exceptions: honest headline, report.json count, report.md section', () => {
  const accepted = [{ severity: 'ERROR', path: 'paths./api/appointments/', issue: 'There should be no trailing slashes on paths', reason: 'Real route | coordinated migration' }];
  const lintStep = { ...step('contract-lint', 'pass', 100), accepted };
  const { report, markdown } = run({ 'contract-lint': lintStep });
  assert.equal(report.passed, true);
  assert.match(report.headline, /^PASSED with 1 accepted lint exception /);
  assert.equal(report.steps.find((s) => s.step === 'contract-lint').accepted_exceptions, 1);
  assert.equal(report.steps.find((s) => s.step === 'coverage').accepted_exceptions, undefined);
  assert.match(markdown, /### Accepted exceptions \(human decisions\)/);
  assert.match(markdown, /paths\.\/api\/appointments\//);
  assert.match(markdown, /Real route \\\| coordinated migration/);
  assert.match(markdown, /PASSED with 1 accepted lint exception/);
});

test('no accepted exception: no headline and no section', () => {
  const { report, markdown } = run();
  assert.equal(report.headline, null);
  assert.doesNotMatch(markdown, /Accepted exceptions/);
});

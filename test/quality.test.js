'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { aggregate } = require('../core/aggregate');
const { validateConfig, ConfigError } = require('../core/config');
const { indexFromScores, scoresOf, computeDelta, gateScore, scoreDelta, changeRisk, configHash, ratchet, QUALITY_STEPS } = require('../core/quality');
const { skippedReport, headCommit } = require('../core/report');
const { fromReport, resolveBaseline } = require('../core/baseline');
const { buildContext } = require('../core/runner');
const { exec: realExec } = require('../core/exec');
const { GATE_VERSION } = require('../core/constants');
const { fixture, project, tmp, fakeExec } = require('./helpers');

const cfg = validateConfig({});
const step = (s, status, score, details = []) => ({ step: s, status, score, summary: `${s} ${status}`, details, command: '' });
const green = () => ({
  'skills-check': step('skills-check', 'pass', 100),
  'contract-lint': step('contract-lint', 'pass', 100),
  'contract-tests': step('contract-tests', 'pass', 100),
  coverage: step('coverage', 'pass', 100),
  'ai-readiness': step('ai-readiness', 'pass', 100),
  impact: step('impact', 'pass', 100),
});
const baseline = (steps, index, extra = {}) => ({ ref: 'origin/main', sha: 'a'.repeat(40), source: 'artifact', gate_version: GATE_VERSION, quality_index: index, steps, ...extra });
const BASE_ALL = { 'contract-lint': 100, 'contract-tests': 100, coverage: 100, 'ai-readiness': 60 };

// ---- index -------------------------------------------------------------------------------------------------
test('API quality index: weighted over the four quality steps only, weights re-normalized', () => {
  // weights 25, 20, 5, 20 -> 70
  assert.equal(indexFromScores(cfg, BASE_ALL), Math.round((25 * 100 + 20 * 100 + 5 * 100 + 20 * 60) / 70));
  // skills-check and impact never count, even when given
  assert.equal(indexFromScores(cfg, { ...BASE_ALL, 'skills-check': 0, impact: 0 }), 89);
  // not_available (null) is left out, like in the gate score
  assert.equal(indexFromScores(cfg, { ...BASE_ALL, 'ai-readiness': null }), 100);
  assert.equal(indexFromScores(cfg, { 'contract-lint': null }), null);
  assert.equal(indexFromScores(cfg, {}), null);
  assert.deepEqual(QUALITY_STEPS, ['contract-lint', 'contract-tests', 'coverage', 'ai-readiness']);
});

test('API quality index: a step disabled in the config or weighted 0 is left out', () => {
  assert.equal(indexFromScores(validateConfig({ steps: ['contract-lint', 'coverage'], required_steps: ['contract-lint'], blockers: {} }), BASE_ALL), 100);
  assert.equal(indexFromScores(validateConfig({ weights: { 'ai-readiness': 0 } }), BASE_ALL), 100);
});

test('scoresOf reads the step results and treats not_available as null', () => {
  assert.deepEqual(scoresOf([step('coverage', 'warn', 66), step('impact', 'fail', 0), { step: 'contract-lint', status: 'not_available', score: null }]), { coverage: 66, 'contract-lint': null });
});

// ---- delta -------------------------------------------------------------------------------------------------
test('delta: points, percent and stable, rounded on the index', () => {
  const head = { 'contract-lint': 100, 'contract-tests': 0, coverage: 100, 'ai-readiness': 60 }; // 60
  const d = computeDelta(cfg, head, baseline(BASE_ALL, 89));
  assert.deepEqual([d.base, d.head, d.points, d.percent, d.stable], [89, 60, -29, -33, false]);
  const up = computeDelta(cfg, { ...BASE_ALL, 'ai-readiness': 100 }, baseline(BASE_ALL, 89));
  assert.deepEqual([up.points, up.percent, up.stable], [11, 12, false]);
});

test('delta: stable boundary', () => {
  const base = baseline({ 'contract-lint': 100, 'contract-tests': 100, coverage: 100, 'ai-readiness': 100 }, 100);
  const at = (score) => computeDelta(cfg, { 'contract-lint': 100, 'contract-tests': 100, coverage: 100, 'ai-readiness': score }, base);
  assert.equal(at(90).points, -3); // 20/70 * 10 = 2.86 -> 97
  assert.equal(at(90).stable, false);
  assert.equal(at(93).points, -2);
  assert.equal(at(93).stable, true);
  assert.equal(at(100).stable, true);
});

test('delta: not comparable without a baseline, without scores, or without a common step; never a number', () => {
  assert.equal(computeDelta(cfg, BASE_ALL, null), null);
  assert.equal(computeDelta(cfg, BASE_ALL, baseline(null, null, { source: 'none' })), null);
  assert.equal(computeDelta(cfg, { 'contract-lint': null }, baseline(BASE_ALL, 89)), null);
  assert.equal(computeDelta(cfg, { coverage: 100 }, baseline({ 'ai-readiness': 60 }, 60)), null);
});

test('delta: computed on the steps both sides have (an index over other steps would not compare)', () => {
  const d = computeDelta(cfg, BASE_ALL, baseline({ 'contract-lint': 100, 'contract-tests': 100, coverage: 100, 'ai-readiness': null }, 100));
  assert.deepEqual(d.steps, ['contract-lint', 'contract-tests', 'coverage']);
  assert.equal(d.head, 100);
  assert.equal(d.points, 0);
});

test('delta: a base index of 0 gives points but no percent', () => {
  const d = computeDelta(cfg, { 'contract-lint': 50 }, baseline({ 'contract-lint': 0 }, 0));
  assert.deepEqual([d.points, d.percent], [50, null]);
});

// ---- change risk ---------------------------------------------------------------------------------------------
test('change risk comes from impact: breaking with consumers, breaking without, none, not assessed', () => {
  const consumer = (breaking) => ({ check: 'consumer', breaking });
  assert.deepEqual(changeRisk([step('impact', 'fail', 0, [consumer(true), consumer(true), { check: 'breaking-change', result: 'x' }])]), { assessed: true, breaking: true, consumers: 2 });
  assert.deepEqual(changeRisk([step('impact', 'warn', 60, [{ check: 'breaking-change', result: 'x' }])]), { assessed: true, breaking: true, consumers: 0 });
  assert.deepEqual(changeRisk([step('impact', 'pass', 100, [consumer(false)])]), { assessed: true, breaking: false, consumers: 1 });
  assert.equal(changeRisk([{ step: 'impact', status: 'not_available', score: null }]).assessed, false);
  assert.equal(changeRisk([]).assessed, false);
});

// ---- ratchet -----------------------------------------------------------------------------------------------
test('config: no_regression is off by default, validated when set', () => {
  assert.equal(validateConfig({}).no_regression, null);
  assert.deepEqual(validateConfig({ no_regression: { max_drop: 5 } }).no_regression, { max_drop: 5 });
  for (const bad of [{ max_drop: -1 }, {}, { max_drop: 'x' }, { max_drop: 5, other: 1 }, 3]) {
    assert.throws(() => validateConfig({ no_regression: bad }), ConfigError, JSON.stringify(bad));
  }
});

test('ratchet: a drop larger than max_drop is a blocker, equal is fine, no baseline is not enforced', () => {
  const r = validateConfig({ no_regression: { max_drop: 5 } });
  const d = (points) => ({ points, base: 90, head: 90 + points });
  assert.equal(ratchet(r, d(-6), 'main').status, 'violated');
  assert.match(ratchet(r, d(-6), 'main').blocker, /dropped by 6 points against main \(90 → 84\).*allowed drop is 5/);
  assert.equal(ratchet(r, d(-5), 'main').status, 'ok');
  assert.equal(ratchet(r, d(+8), 'main').status, 'ok');
  assert.equal(ratchet(r, null, 'main').status, 'not_comparable');
  assert.equal(ratchet(cfg, d(-50), 'main').status, 'off');
});

test('ratchet in the gate: blocks a gate that would pass, not when off', () => {
  const head = { ...green(), 'ai-readiness': step('ai-readiness', 'pass', 85) }; // index 95 -> rating A, no blocker
  const meta = { baseline: baseline({ 'contract-lint': 100, 'contract-tests': 100, coverage: 100, 'ai-readiness': 100 }, 100) };
  const off = aggregate(cfg, head, meta);
  assert.equal(off.report.passed, true);
  assert.equal(off.report.no_regression, undefined);
  const on = aggregate(validateConfig({ no_regression: { max_drop: 2 } }), head, meta);
  assert.equal(on.report.passed, false);
  assert.match(on.report.blockers[0], /API quality dropped by 4 points against main/);
  assert.deepEqual(on.report.no_regression, { max_drop: 2, status: 'violated' });
  assert.match(on.markdown, /Ratchet \(no_regression\.max_drop 2\): violated/);
  const lenient = aggregate(validateConfig({ no_regression: { max_drop: 10 } }), head, meta);
  assert.equal(lenient.report.passed, true);
  const noBase = aggregate(validateConfig({ no_regression: { max_drop: 2 } }), head, {});
  assert.equal(noBase.report.passed, true);
  assert.match(noBase.markdown, /not enforced, no comparable baseline/);
});

// ---- headline and report -----------------------------------------------------------------------------------------
test('headline: the failing rehearsal, rating, quality delta and risk', () => {
  const head = {
    ...green(),
    'contract-tests': step('contract-tests', 'fail', 0),
    impact: step('impact', 'fail', 0, [...Array.from({ length: 32 }, () => ({ check: 'consumer', breaking: true })), { check: 'breaking-change', result: 'x' }]),
  };
  const base = baseline({ 'contract-lint': 100, 'contract-tests': 100, coverage: 100, 'ai-readiness': 60 }, 89);
  const { report, markdown } = aggregate(cfg, head, { baseline: base });
  // head index: (25*100 + 0 + 5*100 + 20*100) / 70 = 71.43 -> 71 ; base 83
  assert.equal(report.quality_index, 71);
  assert.deepEqual(report.delta, { points: -18, percent: -20, stable: false });
  assert.deepEqual(report.risk, { breaking: true, consumers: 32 });
  assert.equal(report.headline, `rating D (${report.score}/100) · API quality 89 → 71 vs main (−18 pts, −20 %) · breaking change for 32 consumers`);
  assert.ok(markdown.includes('## ❌ API quality gate: FAILED\n'));
  assert.deepEqual(report.baseline, base);
});

test('headline: the passing case, improvement and no breaking change', () => {
  const { report, markdown } = aggregate(cfg, { ...green(), 'ai-readiness': step('ai-readiness', 'pass', 90) }, { baseline: baseline(BASE_ALL, 89) });
  assert.equal(report.quality_index, 97);
  assert.equal(report.headline, `PASSED (rating A, ${report.score}/100) · API quality 89 → 97 vs main (+8 pts, +9 %) · no breaking change`);
  assert.ok(markdown.includes('## ✅ API quality gate: PASSED\n'));
});

test('headline: stable, one consumer, breaking without known consumer, accepted exceptions', () => {
  const near = aggregate(cfg, green(), { baseline: baseline({ 'contract-lint': 100, 'contract-tests': 100, coverage: 100, 'ai-readiness': 97 }, 99) });
  assert.match(near.report.headline, /API quality 99 → 100 vs main \(\+1 pts, \+1 %, stable\)/);
  const one = aggregate(cfg, { ...green(), impact: step('impact', 'fail', 0, [{ check: 'consumer', breaking: true }]) }, {});
  assert.match(one.report.headline, /breaking change for 1 consumer$/);
  const none = aggregate(cfg, { ...green(), impact: step('impact', 'warn', 60, [{ check: 'breaking-change', result: 'x' }]) }, {});
  assert.match(none.report.headline, /breaking change, no known consumer$/);
  const acc = aggregate(cfg, { ...green(), 'contract-lint': { ...step('contract-lint', 'pass', 100), accepted: [{ severity: 'ERROR', path: 'p', issue: 'i', reason: 'r' }] } }, { baseline: baseline(BASE_ALL, 89) });
  assert.match(acc.report.headline, /^PASSED with 1 accepted lint exception \(rating A, 100\/100\) · API quality 89 → 100 vs main/);
});

test('headline: not comparable says why and never prints a delta', () => {
  const none = { ref: 'origin/main', sha: null, source: 'none', gate_version: null, quality_index: null, steps: null, reason: 'no merge base' };
  const { report, markdown } = aggregate(cfg, green(), { baseline: none });
  assert.equal(report.delta, null);
  assert.match(report.headline, /API quality 100, not comparable with main/);
  assert.doesNotMatch(report.headline, /pts/);
  assert.match(markdown, /\*\*API quality: 100 · not comparable with `main`\*\*/);
  assert.match(markdown, /Not comparable with `main`: no merge base/);
  const missing = aggregate(cfg, green(), {});
  assert.equal(missing.report.baseline.source, 'none');
  assert.match(missing.report.headline, /not comparable with base/);
});

test('report.md: per-step base -> head column only when comparable', () => {
  const head = { ...green(), 'contract-tests': step('contract-tests', 'fail', 0) };
  const { markdown } = aggregate(cfg, head, { baseline: baseline(BASE_ALL, 89) });
  assert.match(markdown, /\| Step \| Score \| vs main \| Summary \|/);
  assert.match(markdown, /\| \S+ contract-tests \| 0 \| ⬇️ −100 \|/);
  assert.match(markdown, /\| \S+ ai-readiness \| 100 \| ⬆️ \+40 \|/);
  assert.match(markdown, /\| \S+ impact \| 100 \| – \|/);
  assert.match(markdown, /\| \S+ coverage \| 100 \| 🟰 0 \|/);
  assert.doesNotMatch(aggregate(cfg, head, {}).markdown, /\| vs main \|/);
});

test('report.json carries the commit and the settings hash; the hash changes with weights, not with blockers', () => {
  const { report } = aggregate(cfg, green(), { commit: 'abc' });
  assert.equal(report.commit, 'abc');
  assert.equal(report.config_hash, configHash(cfg));
  assert.notEqual(configHash(validateConfig({ weights: { coverage: 10 } })), configHash(cfg));
  assert.equal(configHash(validateConfig({ blockers: {} })), configHash(cfg));
});

// ---- skipped run -----------------------------------------------------------------------------------------------
test('skipped run: the sticky comment says the branch no longer changes the contract', () => {
  const { report, markdown } = skippedReport('origin/main');
  assert.ok(markdown.startsWith('<!-- healthcare-api-quality-gate -->'));
  assert.match(markdown, /This branch no longer changes the API contract against main; the gate did not run\. If the change was reverted, the original change is no longer in this PR\./);
  assert.deepEqual(report, { skipped: true, reason: 'no relevant change', base: 'main' });
  assert.match(skippedReport().markdown, /against the base branch;/);
});

test('bin skipped: writes report.md and report.json', () => {
  const out = tmp();
  const r = spawnSync('node', [path.join(__dirname, '..', 'bin', 'healthcare-api-quality-gate.js'), 'skipped', '--base', 'develop', '--results-dir', out], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')).skipped, true);
  assert.match(fs.readFileSync(path.join(out, 'report.md'), 'utf8'), /against develop;/);
});

// ---- baseline resolution -----------------------------------------------------------------------------------------
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const copy = (src, dst) => { fs.mkdirSync(dst, { recursive: true }); fs.cpSync(src, dst, { recursive: true }); };

/** A git repo: fixtures/green on main (coverage 100), then a branch whose spec has an operation without request. */
function repo() {
  const dir = tmp();
  copy(fixture('green'), dir);
  fs.writeFileSync(path.join(dir, 'quality-gate.yml'), 'steps: [coverage]\nrequired_steps: []\nblockers: {}\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  const sha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-qb', 'feature');
  const spec = path.join(dir, 'specs/pets.yaml');
  fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace(/\npaths:\n/, '\npaths:\n  /owners:\n    get:\n      operationId: listOwners\n      summary: List owners\n      responses:\n        "200": { description: ok }\n'));
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'head');
  return { dir, sha };
}
const ctxFor = (dir, env = { GATE_BASE_REF: 'main' }) => buildContext({ cwd: dir, resultsDir: tmp(), overrides: { exec: (cmd, args, o) => (cmd === 'git' ? realExec(cmd, args, o) : { status: 1, stdout: '', stderr: '', error: new Error('no cli') }), env: { ...process.env, ...env }, log() {} } });

test('baseline rerun: the quality steps run on a worktree of the merge-base, nothing is left behind', () => {
  const { dir, sha } = repo();
  const ctx = ctxFor(dir);
  const b = resolveBaseline(ctx);
  assert.equal(b.source, 'rerun');
  assert.equal(b.sha, sha);
  assert.equal(b.ref, 'main');
  assert.equal(b.quality_index, 100);
  assert.deepEqual(b.steps, { coverage: 100 });
  assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('baseline: a comparable report of that commit is used as is (source artifact), no rerun', () => {
  const { dir, sha } = repo();
  const ctx = ctxFor(dir);
  const file = path.join(tmp(), 'report.json');
  const report = { gate_version: GATE_VERSION, config_hash: configHash(ctx.config), commit: sha, steps: [{ step: 'coverage', status: 'pass', score: 80 }, { step: 'impact', status: 'pass', score: 100 }] };
  fs.writeFileSync(file, JSON.stringify(report));
  const b = resolveBaseline(ctx, { reportFile: file });
  assert.deepEqual([b.source, b.quality_index, b.steps, b.sha], ['artifact', 80, { coverage: 80 }, sha]);
});

test('baseline: a report of another gate version, other settings, another commit or a skipped run falls back to a rerun', () => {
  const { dir, sha } = repo();
  const ctx = ctxFor(dir);
  const good = { gate_version: GATE_VERSION, config_hash: configHash(ctx.config), commit: sha, steps: [{ step: 'coverage', status: 'pass', score: 80 }] };
  const base = { ref: 'main', sha };
  for (const [name, report, why] of [
    ['version', { ...good, gate_version: '0.5.0' }, /gate 0\.5\.0, this is/],
    ['settings', { ...good, config_hash: 'other' }, /different gate settings/],
    ['commit', { ...good, commit: 'f'.repeat(40) }, /not /],
    ['skipped', { skipped: true }, /skipped/],
    ['empty', { ...good, steps: [] }, /no scored quality step/],
  ]) {
    const file = path.join(tmp(), 'report.json');
    fs.writeFileSync(file, JSON.stringify(report));
    assert.match(fromReport(ctx, base, file).reason, why, name);
    const b = resolveBaseline(ctx, { reportFile: file });
    assert.equal(b.source, 'rerun', name);
    assert.equal(b.quality_index, 100, name);
  }
  assert.match(fromReport(ctx, base, '/nonexistent/report.json').reason, /no gate report/);
});

test('baseline: GATE_BASE_REF by SHA with a display name; no merge base or not a repo gives none with the reason', () => {
  const { dir, sha } = repo();
  const b = resolveBaseline(ctxFor(dir, { GATE_BASE_REF: sha, GATE_BASE_NAME: 'main' }));
  assert.deepEqual([b.source, b.ref, b.sha], ['rerun', 'main', sha]);
  const nobase = resolveBaseline(ctxFor(dir, {}));
  assert.equal(nobase.source, 'none');
  assert.match(nobase.reason, /no base branch found/);
  const n = resolveBaseline(buildContext({ cwd: tmp(), resultsDir: tmp(), overrides: { exec: fakeExec(() => ({ status: 1 })), env: {}, log() {} } }));
  assert.equal(n.source, 'none');
  assert.equal(n.quality_index, null);
  assert.ok(n.reason);
});

test('baseline end to end: the delta of a branch that adds an operation without request', () => {
  const { dir } = repo();
  const ctx = ctxFor(dir);
  const baselineResult = resolveBaseline(ctx);
  const { report } = aggregate(ctx.config, { coverage: step('coverage', 'warn', 50) }, { baseline: baselineResult });
  assert.deepEqual(report.delta, { points: -50, percent: -50, stable: false });
  assert.match(report.headline, /API quality 100 → 50 vs main \(−50 pts, −50 %\)/);
});

// ---- gate score delta (first line of the comment) ------------------------------------------------------------------
const ALL100_Q = { 'contract-lint': 100, 'contract-tests': 100, coverage: 100, 'ai-readiness': 100 };
// PR #8 of healthcare-patients: every quality step as on main, impact 0 (breaking change for 32 consumers), skills-check 100.
const pr8Head = () => ({
  ...green(),
  'contract-lint': step('contract-lint', 'warn', 90),
  impact: step('impact', 'fail', 0, [...Array.from({ length: 32 }, () => ({ check: 'consumer', breaking: true })), { check: 'breaking-change', result: 'x' }]),
});
const PR8_BASE = { 'contract-lint': 90, 'contract-tests': 100, coverage: 100, 'ai-readiness': 100 };

test('scoreDelta: the base score is reconstructed even from an artifact; a score in the baseline is ignored', () => {
  const steps = Object.values(pr8Head());
  // the base report's own score (here 40: its last change was breaking) must not leak in
  const d = scoreDelta(cfg, steps, baseline(PR8_BASE, 97, { score: 40 }));
  assert.equal(d.head, gateScore(cfg, steps));
  assert.deepEqual([d.base, d.source], [98, 'artifact']);
  assert.equal(d.points, d.head - 98);
});

test('scoreDelta: impact counted 100 and skills-check from the head; source says where the base steps came from', () => {
  const steps = Object.values(pr8Head());
  const rerun = scoreDelta(cfg, steps, baseline(PR8_BASE, 97, { source: 'rerun' }));
  const artifact = scoreDelta(cfg, steps, baseline(PR8_BASE, 97));
  assert.deepEqual([rerun.source, artifact.source], ['rerun', 'artifact']);
  for (const d of [rerun, artifact]) assert.deepEqual([d.base, d.head, d.points, d.percent, d.stable], [98, 78, -20, -20, false]);
  // skills-check comes from the head: a head at 40 changes both sides alike
  const low = Object.values({ ...pr8Head(), 'skills-check': step('skills-check', 'fail', 40) });
  const d = scoreDelta(cfg, low, baseline(PR8_BASE, 97));
  assert.equal(d.base - d.head, 20);
});

test('scoreDelta: a step missing on the head is left out of both sides, one missing on the base only from the base', () => {
  const head = Object.values({ ...green(), coverage: { step: 'coverage', status: 'not_available', score: null } });
  const d = scoreDelta(cfg, head, baseline({ 'contract-lint': 100, 'contract-tests': 100, coverage: 0, 'ai-readiness': 100 }, 100));
  assert.deepEqual([d.head, d.base], [100, 100]);
  const d2 = scoreDelta(cfg, Object.values(green()), baseline({ 'contract-lint': 100, 'contract-tests': 100, 'ai-readiness': 100 }, 100));
  assert.equal(d2.base, 100);
});

test('scoreDelta: stable threshold, percent null on a zero base, not comparable without a baseline', () => {
  const near = scoreDelta(cfg, Object.values(green()), baseline({ ...ALL100_Q, 'ai-readiness': 90 }, 97)); // base 98
  assert.deepEqual([near.points, near.stable], [2, true]);
  const far = scoreDelta(cfg, Object.values(green()), baseline({ ...ALL100_Q, 'ai-readiness': 85 }, 96)); // base 97
  assert.deepEqual([far.points, far.stable, far.percent], [3, false, 3]);
  const one = validateConfig({ steps: ['contract-lint'], required_steps: ['contract-lint'], blockers: {} });
  assert.equal(scoreDelta(one, [step('contract-lint', 'warn', 50)], baseline({ 'contract-lint': 0 }, 0)).percent, null);
  assert.equal(scoreDelta(cfg, Object.values(green()), null), null);
  assert.equal(scoreDelta(cfg, Object.values(green()), baseline(null, null, { source: 'none' })), null);
  assert.equal(scoreDelta(cfg, [], baseline(PR8_BASE, 97)), null);
  assert.equal(scoreDelta(cfg, Object.values(green()), baseline(null, null, { source: 'artifact' })), null);
});

test('PR #8 shape: quality steps equal to main, impact 0: index unchanged (96 -> 96), gate score lowered', () => {
  const head = { ...green(), 'contract-lint': step('contract-lint', 'warn', 90), impact: step('impact', 'fail', 0, [{ check: 'consumer', breaking: true }]) };
  const { report, markdown } = aggregate(cfg, head, { baseline: baseline(PR8_BASE, 96) });
  assert.equal(report.score, 78);
  assert.deepEqual(report.delta, { points: 0, percent: 0, stable: true });
  assert.deepEqual(report.score_delta, { base: 98, head: 78, points: -20, percent: -20, stable: false, source: 'artifact' });
  assert.ok(markdown.includes('**⬇️ API quality is lowered by 20 % from `main`**'));
  assert.match(markdown, /API quality index \(contract-lint, contract-tests, coverage, ai-readiness\): 96 → 96 · base score 98 reconstructed from main's steps \(gate report of that commit\), impact counted 100, skills-check from this run/);
});

test('PR #8 numbers: all quality steps as on main (index 91 -> 91), impact 0 -> base 94, head 74, lowered by 21 %', () => {
  // weights: skills-check 10 (100), contract-lint 25 (100), contract-tests 20 (100), coverage 5 (100), ai-readiness 20 (70), impact 20 (0)
  const head = { ...green(), 'ai-readiness': step('ai-readiness', 'warn', 70), impact: step('impact', 'fail', 0, [{ check: 'consumer', breaking: true }]) };
  const base = baseline({ ...ALL100_Q, 'ai-readiness': 70 }, 91, { source: 'rerun' });
  const { report, markdown } = aggregate(cfg, head, { baseline: base });
  assert.equal(report.score, 74);
  assert.equal(report.quality_index, 91);
  assert.deepEqual(report.score_delta, { base: 94, head: 74, points: -20, percent: -21, stable: false, source: 'rerun' });
  assert.ok(markdown.includes('**⬇️ API quality is lowered by 21 % from `main`**'));
  assert.match(markdown, /API quality index \(contract-lint, contract-tests, coverage, ai-readiness\): 91 → 91 · base score 94 reconstructed from main's steps \(re-run\), impact counted 100, skills-check from this run/);
});

test('a breaking change already merged on main does not make a clean PR read "raised"', () => {
  // base report with a low score of its own (impact 0 on main): ignored, the base is reconstructed with impact 100
  const { report, markdown } = aggregate(cfg, green(), { baseline: baseline(ALL100_Q, 100, { score: 80 }) });
  assert.deepEqual([report.score_delta.base, report.score_delta.points], [100, 0]);
  assert.ok(markdown.includes('**🟰 API quality is unchanged from `main`**'));
});

test('passing case unchanged: no regression keeps "unchanged" and the same headline and delta', () => {
  const { report, markdown } = aggregate(cfg, green(), { baseline: baseline(ALL100_Q, 100) });
  assert.ok(markdown.includes('**🟰 API quality is unchanged from `main`**'));
  assert.equal(report.headline, 'PASSED (rating A, 100/100) · API quality 100 → 100 vs main (+0 pts, +0 %, stable) · no breaking change'.replace('+0', '0').replace('+0', '0'));
  assert.deepEqual(report.score_delta, { base: 100, head: 100, points: 0, percent: 0, stable: true, source: 'artifact' });
});

test('not comparable: score_delta is null and the line says why', () => {
  const none = { ref: 'origin/main', sha: null, source: 'none', gate_version: null, quality_index: null, steps: null, reason: 'no merge base' };
  const { report, markdown } = aggregate(cfg, green(), { baseline: none });
  assert.equal(report.score_delta, null);
  assert.equal(report.delta, null);
  assert.match(markdown, /not comparable with `main`/);
  assert.doesNotMatch(markdown, /base score/);
});

test('report.json keeps quality_index, delta, headline and the ratchet on the index; score_delta is additive', () => {
  const head = { ...green(), 'ai-readiness': step('ai-readiness', 'pass', 90) };
  const { report } = aggregate(cfg, head, { baseline: baseline(BASE_ALL, 89) });
  assert.equal(report.schema_version, 1);
  assert.equal(report.quality_index, 97);
  assert.deepEqual(report.delta, { points: 8, percent: 9, stable: false });
  assert.match(report.headline, /API quality 89 → 97 vs main \(\+8 pts, \+9 %\)/);
  assert.ok(report.score_delta && report.score_delta.source === 'artifact');
  // the ratchet still reads the index delta: index 100 -> 100 passes even though the gate score drops (impact 0)
  const imp = { ...green(), impact: step('impact', 'fail', 0, [{ check: 'consumer', breaking: true }]) };
  const r = aggregate(validateConfig({ no_regression: { max_drop: 0 } }), imp, { baseline: baseline(ALL100_Q, 100) });
  assert.deepEqual(r.report.no_regression, { max_drop: 0, status: 'ok' });
  assert.ok(r.report.score_delta.points < 0);
});

// ---- head SHA ----------------------------------------------------------------------------------------------------
test('commit: the PR head SHA of the event payload wins over the merge commit; env override; fallback', () => {
  const merge = '8e1b4ad'.padEnd(40, '0');
  const head = 'b6a4da9'.padEnd(40, '1');
  const event = path.join(tmp(), 'event.json');
  fs.writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: head } } }));
  assert.equal(headCommit({ GITHUB_EVENT_PATH: event }, merge), head);
  assert.equal(headCommit({ GATE_HEAD_SHA: 'c'.repeat(40), GITHUB_EVENT_PATH: event }, merge), 'c'.repeat(40));
  fs.writeFileSync(event, JSON.stringify({ ref: 'refs/heads/main' })); // push event: no pull_request
  assert.equal(headCommit({ GITHUB_EVENT_PATH: event }, merge), merge);
  assert.equal(headCommit({ GITHUB_EVENT_PATH: path.join(tmp(), 'none.json') }, merge), merge);
  assert.equal(headCommit({ GATE_HEAD_SHA: 'not a sha' }, merge), merge);
  assert.equal(headCommit({}, null), null);
});

test('bin aggregate: report.json commit is the PR head SHA from GITHUB_EVENT_PATH', () => {
  const dir = project({ 'x.txt': 'x' });
  const run = (args, env) => spawnSync('node', [path.join(__dirname, '..', 'bin', 'healthcare-api-quality-gate.js'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  const out = path.join(dir, 'results');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'coverage.json'), JSON.stringify(step('coverage', 'pass', 90)));
  const event = path.join(dir, 'event.json');
  fs.writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: 'd'.repeat(40) } } }));
  const r = run(['aggregate', '--results-dir', out, '--no-exit-code'], { GITHUB_EVENT_PATH: event });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')).commit, 'd'.repeat(40));
});

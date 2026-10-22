'use strict';
// Each step's output parsing, using recorded CLI output samples (test/samples). No network, no CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const skills = require('../steps/skills-check');
const lint = require('../steps/contract-lint');
const tests = require('../steps/contract-tests');
const coverage = require('../steps/coverage');
const ai = require('../steps/ai-readiness');
const impact = require('../steps/impact');
const { RUNNER_COMMAND, DEGRADED_SCORE_CAP } = require('../core/constants');
const { sample, fixture, fakeExec } = require('./helpers');
const { validateConfig } = require('../core/config');
const path = require('path');
const YAML = require('yaml');
const fs = require('fs');

// ---- skills-check ------------------------------------------------------------------------------------------
test('skills-check: current -> pass 100, behind -> warn 50, foreign/other -> not_available with the message', () => {
  assert.deepEqual([skills.parseSkillsStatus(sample('skills-current.json'))].map((r) => [r.status, r.score]), [['pass', 100]]);
  const behind = skills.parseSkillsStatus(sample('skills-behind.json'));
  assert.deepEqual([behind.status, behind.score], ['warn', 50]);
  assert.match(behind.details[0].hint, /postman skills update/);
  const foreign = skills.parseSkillsStatus(sample('skills-foreign.json'));
  assert.equal(foreign.status, 'not_available');
  assert.equal(foreign.score, null);
  assert.match(foreign.summary, /foreign/);
  assert.equal(skills.parseSkillsStatus('not json').status, 'not_available');
});

// ---- contract-lint -----------------------------------------------------------------------------------------
test('contract-lint: clean spec passes with 100', () => {
  const r = lint.parseLint(sample('lint-clean.json'), 'specs/pets.yaml', 'cmd');
  assert.deepEqual([r.status, r.score, r.summary], ['pass', 100, 'No lint issue']);
});

test('contract-lint: 2 errors + 1 warning -> fail, score 100 - 80 - 10', () => {
  const r = lint.parseLint(sample('lint-errors.json'), 'specs/pets.yaml', 'cmd');
  assert.deepEqual([r.status, r.score, r.summary], ['fail', 10, '2 error(s), 1 warning(s), 0 other']);
  assert.match(r.details[0].hint, /^Fix specs\/pets\.yaml at paths\.\/pets\.post.*line 55/);
  assert.ok(r.details[0].hint.includes(`${RUNNER_COMMAND} run contract-lint`));
});

test('contract-lint: warnings only -> warn; numeric severities; no JSON -> not_available', () => {
  const w = lint.parseLint(JSON.stringify({ violations: [{ severity: 'WARNING', path: 'a', issue: 'x' }, { severity: 1, path: 'b', issue: 'y' }] }), 's', 'c');
  assert.deepEqual([w.status, w.score], ['warn', 80]);
  const e = lint.parseLint(JSON.stringify({ violations: [{ severity: 0, path: 'a', issue: 'x' }] }), 's', 'c');
  assert.deepEqual([e.status, e.score], ['fail', 60]);
  const o = lint.parseLint(JSON.stringify({ violations: [{ severity: 'INFO', path: 'a', issue: 'x' }] }), 's', 'c');
  assert.deepEqual([o.status, o.score], ['pass', 100]);
  assert.equal(lint.parseLint('', 's', 'c').status, 'not_available');
  assert.equal(lint.parseLint('{"x":1}', 's', 'c').status, 'not_available');
});

// ---- contract-tests ----------------------------------------------------------------------------------------
const ctx = { collectionPath: 'collections/Pets API', specPath: 'specs/pets.yaml', command: 'cmd' };

test('contract-tests: passing run summary -> pass, score = pass ratio', () => {
  const s = tests.parseRunSummary(sample('run-summary-green.yaml'));
  assert.deepEqual([s.executed, s.failed, s.requestErrors, s.failures.length], [10, 0, 0, 0]);
  const r = tests.evaluate(s, ctx);
  assert.deepEqual([r.status, r.score], ['pass', 100]);
});

test('contract-tests: failing run uses the structured failures[] of the summary', () => {
  const s = tests.parseRunSummary(sample('run-summary-failed.yaml'));
  assert.deepEqual([s.executed, s.failed], [3, 3]);
  assert.equal(s.failures[0].request, 'List pets');
  assert.match(s.failures[0].test, /200 and a list of pets/);
  const r = tests.evaluate(s, ctx);
  assert.deepEqual([r.status, r.score], ['fail', 0]);
  assert.equal(r.details.filter((d) => d.check === 'failure').length, 3);
  assert.match(r.details[1].result, /List pets: 200 and a list of pets.*to contain keys/);
  assert.match(r.details[1].hint, /specs\/pets\.yaml.*collections\/Pets API/);
});

test('contract-tests: score is the pass ratio; stdout grep is only a fallback when failures[] is empty', () => {
  const partial = { executed: 4, failed: 1, requestErrors: 0, failures: [] };
  const stdout = ' 1.  AssertionError  200 and a page\n                     expected x to equal y\n                     at assertion:0 in test-script\n                     inside "Pets / List"\n';
  const r = tests.evaluate(partial, { ...ctx, stdout });
  assert.deepEqual([r.status, r.score], ['fail', 75]);
  assert.match(r.details.find((d) => d.check === 'failure').result, /Pets \/ List: 200 and a page: expected x to equal y/);
  const structured = tests.evaluate({ ...partial, failures: [{ request: 'R', test: 'T', message: 'M' }] }, { ...ctx, stdout });
  assert.equal(structured.details.filter((d) => d.check === 'failure').length, 1);
  assert.match(structured.details.find((d) => d.check === 'failure').result, /R: T: M/);
});

test('contract-tests: without login the counters table of the stdout is read', () => {
  const ok = tests.parseRunStdout(sample('run-stdout-green-nologin.txt'));
  assert.deepEqual([ok.executed, ok.failed, ok.requestErrors, ok.failures.length], [3, 0, 0, 0]);
  const bad = tests.parseRunStdout(sample('run-stdout-failed-nologin.txt'));
  assert.deepEqual([bad.executed, bad.failed], [3, 3]);
  assert.equal(bad.failures.length, 3);
  assert.equal(bad.failures[0].request, 'Pets / List pets');
  assert.match(bad.failures[0].message, /to contain keys/);
  assert.equal(tests.parseRunStdout('nothing'), null);
});

test('contract-tests: fails on a request error and on 0 assertions', () => {
  assert.equal(tests.evaluate({ executed: 5, failed: 0, requestErrors: 1, failures: [] }, ctx).status, 'fail');
  const zero = tests.evaluate({ executed: 0, failed: 0, requestErrors: 0, failures: [] }, ctx);
  assert.deepEqual([zero.status, zero.score], ['fail', 0]);
});

test('contract-tests: the collection run ALWAYS carries --no-report-events (no upload to Postman Cloud)', () => {
  assert.ok(tests.runArgs('c', 'm.yaml', 'out').includes('--no-report-events'));
  // and the real run() builds that command
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pqg-ct-'));
  const exec = fakeExec((cmd, args) => {
    if (args[0] === 'mock') {
      const out = args[args.indexOf('-o') + 1];
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'config.yaml'), 'port: 4010\n');
    }
    if (args[0] === 'collection') {
      const out = args[args.indexOf('--output') + 1];
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'x.collection-run-summary.yaml'), sample('run-summary-green.yaml'));
    }
  });
  const r = tests.run({ cwd: dir, exec, env: {}, config: validateConfig({}), spec: { path: 'specs/pets.yaml' }, collection: { path: 'collections/Pets API' } });
  const run = exec.calls.find((c) => c[1] === 'collection');
  assert.ok(run.includes('--no-report-events'));
  assert.ok(r.command.includes('--no-report-events'));
  assert.equal(r.status, 'pass');
  assert.ok(exec.calls.find((c) => c[1] === 'mock'), 'a mock is generated from the spec');
});

test('contract-lint: without login, falls back to the syntax rules and says so', () => {
  assert.ok(lint.needsLogin({ stdout: '', stderr: 'Error: Governance linting requires you to be logged in. Run "postman login"' }));
  const exec = fakeExec((cmd, args) => (args.includes('--issueType')
    ? { stdout: sample('lint-errors.json'), status: 1 }
    : { stderr: 'Error: Governance linting requires you to be logged in.', status: 1 }));
  const r = lint.run({ cwd: '.', exec, env: {}, spec: { path: 'specs/pets.yaml' } });
  assert.equal(r.status, 'fail');
  assert.match(r.summary, /syntax rules only/);
  assert.ok(r.command.includes('--issueType syntax'));
});

test('contract-lint: a clean syntax-only lint is degraded: warn, score capped, never a pass', () => {
  const exec = fakeExec((cmd, args) => (args.includes('--issueType')
    ? { stdout: sample('lint-clean.json') }
    : { stderr: 'Governance linting requires you to be logged in.', status: 1 }));
  const r = lint.run({ cwd: '.', exec, env: {}, spec: { path: 'specs/pets.yaml' } });
  assert.deepEqual([r.status, r.score], ['warn', DEGRADED_SCORE_CAP]);
  assert.match(r.degraded, /governance rules skipped/);
  // a logged-in lint is not degraded
  const full = lint.run({ cwd: '.', exec: fakeExec(() => ({ stdout: sample('lint-clean.json') })), env: {}, spec: { path: 's' } });
  assert.deepEqual([full.status, full.score, full.degraded], ['pass', 100, undefined]);
});

test('contract-tests: the stdout counters fallback is NOT degraded (same data as the YAML report)', () => {
  const exec = fakeExec((cmd, args) => {
    if (args[0] === 'mock') {
      const out = args[args.indexOf('-o') + 1];
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'config.yaml'), 'port: 4010\n');
    }
    if (args[0] === 'collection') return args.includes('--output') ? { status: 1, stderr: 'You must be signed in to use --output.' } : { stdout: sample('run-stdout-green-nologin.txt') };
  });
  const r = tests.run({ cwd: '.', exec, env: {}, config: validateConfig({}), spec: { path: 's' }, collection: { path: 'c' } });
  assert.deepEqual([r.status, r.score, r.degraded], ['pass', 100, undefined]);
});

// ---- coverage ----------------------------------------------------------------------------------------------
test('coverage: path normalization', () => {
  const n = coverage.normalizePath;
  assert.equal(n('{{baseUrl}}/pets/:petId?x=1'), '/pets/{}');
  assert.equal(n('/pets/{petId}/'), '/pets/{}');
  assert.equal(n('http://localhost:8080/pets/{{id}}'), '/pets/{}');
  assert.equal(n('{{baseUrl}}'), '/');
});

test('coverage: green fixture is 100%', () => {
  const dir = fixture('green');
  const ops = coverage.operationsOf(YAML.parse(fs.readFileSync(path.join(dir, 'specs/pets.yaml'), 'utf8')));
  assert.equal(ops.length, 3);
  const cov = coverage.computeCoverage(ops, coverage.requestsOf(path.join(dir, 'collections/Pets API')));
  assert.deepEqual([cov.covered, cov.total, cov.percent], [3, 3, 100]);
  assert.equal(coverage.evaluate(cov, { collectionPath: 'c', command: 'x' }).status, 'pass');
});

test('coverage: a missing request warns with the percentage as score and a hint per operation', () => {
  const ops = [{ method: 'GET', path: '/a', key: 'GET /a' }, { method: 'POST', path: '/a/{id}', key: 'POST /a/{}' }, { method: 'GET', path: '/b', key: 'GET /b' }];
  const cov = coverage.computeCoverage(ops, [{ method: 'GET', url: '{{baseUrl}}/a' }]);
  assert.deepEqual([cov.covered, cov.percent], [1, 33]);
  const r = coverage.evaluate(cov, { collectionPath: 'collections/X', command: 'x' });
  assert.deepEqual([r.status, r.score], ['warn', 33]);
  assert.match(r.details[1].hint, /POST \/a\/\{id\}.*collections\/X/);
});

test('coverage: server base paths are accepted in collection URLs; v2.1 JSON collections are read', () => {
  const ops = coverage.operationsOf({ paths: { '/pets': { get: {} } } });
  const cov = coverage.computeCoverage(ops, [{ method: 'GET', url: '{{baseUrl}}/v1/pets' }], ['/v1']);
  assert.equal(cov.percent, 100);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pqg-cov-'));
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, JSON.stringify({ item: [{ name: 'F', item: [{ name: 'r', request: { method: 'GET', url: { raw: '{{baseUrl}}/pets' } } }] }] }));
  assert.deepEqual(coverage.requestsOf(f).map((r) => `${r.method} ${r.url}`), ['GET {{baseUrl}}/pets']);
});

// ---- ai-readiness ------------------------------------------------------------------------------------------
test('ai-readiness: 70 on the recorded sample is a warn with hints per recommendation', () => {
  const r = ai.parseAiReadiness(sample('ai-readiness.json'), 'specs/pets.yaml', 'cmd');
  assert.deepEqual([r.status, r.score, r.summary], ['warn', 70, 'AI readiness 70/100 (Good)']);
  assert.ok(r.details.length > 0);
  assert.match(r.details[0].hint, /specs\/pets\.yaml/);
});

test('ai-readiness: thresholds 80 / 60 by default, configurable', () => {
  const at = (n, t) => ai.parseAiReadiness(JSON.stringify({ readiness: { score_0_100: n, bucket: 'b' } }), 's', 'c', t).status;
  assert.deepEqual([at(80), at(79), at(60), at(59)], ['pass', 'warn', 'warn', 'fail']);
  assert.deepEqual([at(70, { pass_min: 70, warn_min: 50 }), at(49, { pass_min: 70, warn_min: 50 })], ['pass', 'fail']);
  assert.equal(ai.parseAiReadiness('{}', 's', 'c').status, 'not_available');
});

// ---- impact ------------------------------------------------------------------------------------------------
test('impact: consumers from the structured typed query first', () => {
  const c = impact.parseConsumers(sample('context-graph-structured.json'));
  assert.deepEqual(c, [{ name: 'patients-service', endpoint: 'GET /api/appointments/', protocol: 'http', confidence: 0.9 }]);
});

test('impact: falls back to the JSON text answer when structured has no dependencies (recorded real answer)', () => {
  const c = impact.parseConsumers(sample('context-graph-ask.json'));
  assert.equal(c[0].name, 'patients-service');
  assert.equal(c[0].endpoint, 'GET /api/appointments/');
});

test('impact: fenced answers, prose and garbage', () => {
  const ask = (answer) => JSON.stringify({ result: { answer } });
  assert.equal(impact.parseConsumers(ask('```json\n[{"name":"a"}]\n```')).length, 1);
  assert.deepEqual(impact.parseConsumers(ask('[]')), []);
  assert.equal(impact.parseConsumers(ask('I found nothing')), null);
  assert.equal(impact.parseConsumers('oops'), null);
});

test('impact: verdicts', () => {
  const consumers = [{ name: 'patients-service', endpoint: 'GET /x' }];
  const changes = [{ change: "GET /x response 200: property 'a' was removed or renamed", hint: 'keep it' }];
  const ev = (o) => impact.evaluate({ api: 'svc', command: 'c', ...o });
  const fail = ev({ consumers, changed: true, changes });
  assert.deepEqual([fail.status, fail.score], ['fail', 0]);
  assert.equal(fail.details.filter((d) => d.breaking === true).length, 1);
  assert.equal(ev({ consumers: [], changed: true, changes }).status, 'warn');
  assert.equal(ev({ consumers: [], changed: true, changes }).details.some((d) => d.breaking === true), false);
  assert.match(ev({ consumers, changed: true, changes: [] }).summary, /^Additive contract change/);
  assert.match(ev({ consumers, changed: false, changes: [] }).summary, /^Contract unchanged/);
});

const baseSpec = fs.readFileSync(path.join(fixture('breaking-change'), 'base/pets.yaml'), 'utf8');
function impactCtx(askAnswers, { headSpec, baseText = baseSpec, api = 'svc' } = {}) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pqg-imp-'));
  fs.mkdirSync(path.join(dir, 'specs'));
  fs.writeFileSync(path.join(dir, 'specs/pets.yaml'), headSpec);
  let asks = 0;
  const exec = fakeExec((cmd, args) => {
    if (cmd === 'postman') return { stdout: askAnswers[Math.min(asks++, askAnswers.length - 1)] };
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: dir + '\n' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'abc\n' };
    if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'origin/main\n' };
    if (args[0] === 'merge-base') return { status: 0, stdout: 'base123\n' };
    if (args[0] === 'show') return baseText === null ? { status: 128 } : { stdout: baseText };
  });
  return { exec, ctx: { cwd: dir, exec, env: {}, log() {}, config: validateConfig({ impact: { api } }), spec: { path: 'specs/pets.yaml', abs: path.join(dir, 'specs/pets.yaml'), type: 'openapi-3' } } };
}
const answer = (arr) => JSON.stringify({ result: { answer: JSON.stringify(arr) } });

test('impact.run: retries up to 3 asks on an empty answer', () => {
  const head = fs.readFileSync(path.join(fixture('breaking-change'), 'specs/pets.yaml'), 'utf8');
  const { exec, ctx } = impactCtx([answer([]), answer([]), answer([{ name: 'shop-web', endpoint: 'GET /pets' }])], { headSpec: head });
  const r = impact.run(ctx);
  assert.equal(exec.calls.filter((c) => c[0] === 'postman').length, 3);
  assert.equal(r.status, 'fail');
  assert.match(r.summary, /shop-web/);
});

test('impact.run: three empty answers stop at 3 asks and the breaking change is only a warning', () => {
  const head = fs.readFileSync(path.join(fixture('breaking-change'), 'specs/pets.yaml'), 'utf8');
  const { exec, ctx } = impactCtx([answer([])], { headSpec: head });
  const r = impact.run(ctx);
  assert.equal(exec.calls.filter((c) => c[0] === 'postman').length, 3);
  assert.equal(r.status, 'warn');
});

test('impact.run: unchanged spec, additive new spec, unusable answer, missing impact.api', () => {
  assert.match(impact.run(impactCtx([answer([{ name: 'a' }])], { headSpec: baseSpec }).ctx).summary, /^Contract unchanged/);
  assert.match(impact.run(impactCtx([answer([{ name: 'a' }])], { headSpec: baseSpec, baseText: null }).ctx).summary, /^Additive/);
  assert.equal(impact.run(impactCtx(['garbage'], { headSpec: baseSpec }).ctx).status, 'not_available');
  const none = impactCtx([answer([])], { headSpec: baseSpec, api: undefined });
  none.ctx.config = validateConfig({});
  const r = impact.run(none.ctx);
  assert.equal(r.status, 'not_available');
  assert.match(r.summary, /impact\.api/);
  assert.equal(none.exec.calls.length, 0, 'no CLI call without impact.api');
});

test('impact.resolveBaseRef: GATE_BASE_REF, then the remote default branch', () => {
  const exec = fakeExec((cmd, args) => (args[0] === 'symbolic-ref' ? { stdout: 'origin/develop\n' } : { status: 0 }));
  assert.equal(impact.resolveBaseRef({ exec, cwd: '.', env: { GATE_BASE_REF: 'origin/x' } }), 'origin/x');
  assert.equal(impact.resolveBaseRef({ exec, cwd: '.', env: {} }), 'origin/develop');
  const nothing = fakeExec(() => ({ status: 1 }));
  assert.equal(impact.resolveBaseRef({ exec: nothing, cwd: '.', env: {} }), 'HEAD');
});

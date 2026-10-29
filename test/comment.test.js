'use strict';
// The PR comment (report.md): quality change first, collapsed detail, no duplicated data.
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregate } = require('../core/aggregate');
const { validateConfig } = require('../core/config');
const { runUrl, skippedReport } = require('../core/report');
const { plural } = require('../core/step-result');
const { GATE_VERSION } = require('../core/constants');

const cfg = validateConfig({});
const step = (s, status, score, details = [], extra = {}) => ({ step: s, status, score, summary: `${s} ${status}`, details, command: '', ...extra });
const green = () => ({
  'skills-check': step('skills-check', 'pass', 100),
  'contract-lint': step('contract-lint', 'pass', 100),
  'contract-tests': step('contract-tests', 'pass', 100),
  coverage: step('coverage', 'pass', 100),
  'ai-readiness': step('ai-readiness', 'pass', 100),
  impact: step('impact', 'pass', 100),
});
const base = (steps, index, extra = {}) => ({ ref: 'origin/main', sha: 'b'.repeat(40), source: 'artifact', gate_version: GATE_VERSION, quality_index: index, steps, ...extra });
const ALL100 = { 'contract-lint': 100, 'contract-tests': 100, coverage: 100, 'ai-readiness': 100 };
const md = (over = {}, meta = {}, c = cfg) => aggregate(c, { ...green(), ...over }, meta).markdown;

test('title is only PASSED or FAILED, the headline stays in report.json', () => {
  const ok = aggregate(cfg, green(), {});
  assert.ok(ok.markdown.startsWith('<!-- healthcare-api-quality-gate -->\n## ✅ API quality gate: PASSED\n'));
  assert.match(ok.report.headline, /^PASSED \(rating A, 100\/100\)/);
  const ko = aggregate(cfg, { ...green(), 'contract-tests': step('contract-tests', 'fail', 30) }, {});
  assert.ok(ko.markdown.includes('## ❌ API quality gate: FAILED\n'));
  assert.doesNotMatch(ko.markdown, /## .*rating/);
});

test('first body line: stable, drop, rise, not comparable, not available', () => {
  const stable = md({}, { baseline: base(ALL100, 100) });
  assert.match(stable, /\n\*\*🟰 API quality is unchanged from `main`\*\*/);
  const drop = md({ 'contract-tests': step('contract-tests', 'fail', 30) }, { baseline: base(ALL100, 100) });
  assert.match(drop, /\*\*⬇️ API quality is lowered by 20 % from `main`\*\*/);
  const rise = md({}, { baseline: base({ ...ALL100, 'ai-readiness': 50 }, 86) });
  assert.match(rise, /\*\*⬆️ API quality is raised by 16 % from `main`\*\*/);
  const zero = md({}, { baseline: base({ ...ALL100, 'ai-readiness': 0, coverage: 0, 'contract-lint': 0, 'contract-tests': 0 }, 0) });
  assert.match(zero, /\*\*⬆️ API quality is raised by 100 pts from `main`\*\*/);
  const near = md({}, { baseline: base({ ...ALL100, 'ai-readiness': 97 }, 99) });
  assert.match(near, /\*\*🟰 API quality is unchanged from `main`\*\*/);
  assert.match(near, /\| 🟢 ai-readiness \| 100 \| ⬆️ \+3 \|/);
  const nc = md({}, {});
  assert.match(nc, /\*\*API quality: 100 · not comparable with `base`\*\*/);
  const none = aggregate(cfg, { 'skills-check': step('skills-check', 'pass', 100) }, {}).markdown;
  assert.match(none, /\*\*API quality: not available\*\*/);
  // the quality change comes before the rating line and the table
  assert.ok(stable.indexOf('API quality is unchanged') < stable.indexOf('Rating **A**'));
  assert.ok(stable.indexOf('Rating **A**') < stable.indexOf('| Step |'));
});

test('change risk line', () => {
  assert.match(md({ impact: step('impact', 'pass', 100, [{ check: 'consumer' }, { check: 'consumer' }]) }), /Change risk: 🟢 no breaking change · 2 known consumers/);
  assert.match(md({ impact: step('impact', 'pass', 100, [{ check: 'consumer', breaking: false }]) }), /· 1 known consumer\n/);
  assert.match(md({ impact: step('impact', 'fail', 0, [{ check: 'consumer', breaking: true }, { check: 'breaking-change', result: 'x' }]) }), /Change risk: 🔴 breaking change for 1 consumer\n/);
  assert.match(md({ impact: step('impact', 'warn', 60, [{ check: 'breaking-change', result: 'x' }]) }), /Change risk: 🔴 breaking change, no known consumer/);
  assert.match(md({ impact: { ...step('impact', 'not_available', null) } }), /Change risk: ⚪ not assessed/);
});

test('rating line: pass rule, accepted exceptions, short commit, CI link only when known', () => {
  const accepted = [{ severity: 'ERROR', path: 'p', issue: 'i', reason: 'r' }];
  const full = md({ 'contract-lint': step('contract-lint', 'pass', 100, [], { accepted }) }, { commit: '034874a1234567890', run_url: 'https://github.com/o/r/actions/runs/42' });
  assert.match(full, /\nRating \*\*A\*\* \(100\/100\) · required: B or better, no blocker · 1 accepted lint exception · commit `034874a` · \[CI run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/42\)\n/);
  const bare = md();
  assert.doesNotMatch(bare, /CI run|commit `/);
  assert.doesNotMatch(bare, /\*\*PASSED\*\*\. Required/);
  assert.equal(aggregate(cfg, green(), { run_url: 'https://x/y' }).report.run_url, 'https://x/y');
  assert.equal('run_url' in aggregate(cfg, green(), {}).report, false);
});

test('run URL is built from the GitHub environment, omitted without it', () => {
  assert.equal(runUrl({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '99' }), 'https://github.com/o/r/actions/runs/99');
  assert.equal(runUrl({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r' }), null);
  assert.equal(runUrl({}), null);
});

test('ratchet line sits right under the rating line', () => {
  const m = md({}, { baseline: base(ALL100, 100) }, validateConfig({ no_regression: { max_drop: 2 } }));
  assert.match(m, /Rating \*\*A\*\*[^\n]*\n\nRatchet \(no_regression\.max_drop 2\): respected\.\n\n\| Step \|/);
});

test('table: no Status, Weight or Command column; vs column with arrows only when a delta exists', () => {
  const head = { ...green(), 'contract-tests': step('contract-tests', 'fail', 30), 'ai-readiness': step('ai-readiness', 'warn', 70), 'skills-check': step('skills-check', 'not_available', null) };
  const m = aggregate(cfg, head, { baseline: base({ ...ALL100, 'ai-readiness': 50 }, 86) }).markdown;
  assert.match(m, /\| Step \| Score \| vs main \| Summary \|/);
  assert.doesNotMatch(m, /\| Status \||\| Weight \||\| Command \|/);
  assert.match(m, /\| 🔴 contract-tests \| 30 \| ⬇️ −70 \| /);
  assert.match(m, /\| 🟠 ai-readiness \| 70 \| ⬆️ \+20 \| /);
  assert.match(m, /\| 🟢 contract-lint \| 100 \| 🟰 0 \| /);
  assert.match(m, /\| 🟢 impact \| 100 \| – \| /);
  assert.match(m, /\| ⚪ skills-check \| n\/a \| – \| /);
  const nobase = md({ 'contract-tests': step('contract-tests', 'fail', 30) });
  assert.match(nobase, /\| Step \| Score \| Summary \|/);
});

test('What to fix (failed) or Suggestions (passed) is collapsed, Blockers is not', () => {
  const failed = md({ 'contract-tests': step('contract-tests', 'fail', 30, [{ result: 'a', hint: 'h' }]) });
  assert.match(failed, /<details><summary>What to fix \(1\)<\/summary>\n\n/);
  assert.doesNotMatch(failed, /Suggestions, non-blocking/);
  assert.match(failed, /\n### Blockers\n\n- contract-tests failed/);
  assert.ok(failed.indexOf('### Blockers') < failed.indexOf('<details>'));
  const passed = md({ 'ai-readiness': step('ai-readiness', 'warn', 70, [{ result: 'a', hint: 'h' }]) });
  assert.match(passed, /<details><summary>Suggestions, non-blocking \(1\)<\/summary>\n\n/);
  assert.doesNotMatch(passed, /What to fix|### Blockers/);
  // every collapsed block has a blank line after its summary
  for (const m of [failed, passed]) for (const line of m.split('\n').flatMap((l, i, a) => (/<summary>/.test(l) ? [a[i + 1]] : []))) assert.equal(line, '');
});

test('findings are grouped by step with one Fix line when the hint is shared', () => {
  const details = Array.from({ length: 3 }, (_, i) => ({ result: `finding ${i}`, hint: 'same hint' }));
  const m = md({ 'ai-readiness': step('ai-readiness', 'warn', 70, details) });
  assert.match(m, /\*\*🟠 ai-readiness\*\*\n\n- finding 0\n- finding 1\n- finding 2\n\nFix: same hint\n/);
  assert.equal(m.split('Fix: same hint').length - 1, 1);
  assert.match(m, /Suggestions, non-blocking \(3\)/);
  const mixed = md({ 'ai-readiness': step('ai-readiness', 'warn', 70, [{ result: 'a', hint: 'ha' }, { result: 'b', hint: 'hb' }]) });
  assert.match(mixed, /- a {2}\n {2}Fix: ha\n- b {2}\n {2}Fix: hb/);
});

test('findings cut by the 8 per step cap say how many are left, report.json keeps 8', () => {
  const details = Array.from({ length: 11 }, (_, i) => ({ result: `f${i}`, hint: 'h' }));
  const r = aggregate(cfg, { ...green(), coverage: step('coverage', 'warn', 50, details) }, {});
  assert.equal(r.report.feedback.length, 8);
  assert.match(r.markdown, /Suggestions, non-blocking \(8\)/);
  assert.match(r.markdown, /- \+3 more \(see the step output\)/);
});

test('degraded feedback stays in the list; raw JSON only for details without result or hint', () => {
  const deg = md({ 'contract-lint': step('contract-lint', 'pass', 100, [], { degraded: 'rules skipped' }) });
  assert.match(deg, /\*\*🟠 contract-lint\*\*\n\n- contract-lint pass[\s\S]*- contract-lint ran degraded: rules skipped/);
  const listed = md({ coverage: step('coverage', 'warn', 50, [{ result: 'a', hint: 'h' }]) });
  assert.doesNotMatch(listed, /```json/);
  const bare = md({ coverage: step('coverage', 'warn', 50, [{ check: 'x' }, { result: 'a', hint: 'h' }]) });
  assert.match(bare, /<details><summary>🟠 coverage: raw details \(1\)<\/summary>\n\n```json/);
});

test('accepted exceptions and reproduce blocks are collapsed; footer carries the context', () => {
  const accepted = [{ severity: 'ERROR', path: 'p', issue: 'i', reason: 'r' }];
  const m = md({ 'contract-lint': step('contract-lint', 'pass', 100, [], { accepted, command: 'postman spec lint x.yaml' }) }, {
    cli_version: '1.76.0', spec: { path: 'openapi.yaml', type: 'openapi-3' }, collection: { path: 'postman/collections/c' }, baseline: base(ALL100, 100),
  });
  assert.match(m, /<details><summary>Accepted exceptions \(1, human decisions\)<\/summary>\n\nThese findings are removed/);
  assert.match(m, /<details><summary>Reproduce locally<\/summary>\n\n/);
  assert.match(m, /\*\*contract-lint\*\*: `npx github:healthcare-org-app\/healthcare-api-quality-gate#v1 run contract-lint`\s+underlying: `postman spec lint x\.yaml`/);
  assert.match(m, new RegExp(`<sub>healthcare-api-quality-gate ${GATE_VERSION} · Postman CLI 1\\.76\\.0 · spec \`openapi\\.yaml\` \\(openapi-3\\) · collection \`postman/collections/c\` · baseline: \`main\` @ \`bbbbbbb\` \\(gate report of that commit\\) · score weights: .*contract-lint 25`));
});

test('plural helper and step summaries', () => {
  assert.equal(plural(1, 'assertion'), '1 assertion');
  assert.equal(plural(10, 'assertion'), '10 assertions');
  assert.equal(plural(0, 'request error'), '0 request errors');
  assert.equal(plural(1, 'known consumer'), '1 known consumer');
});

test('skipped report: same style, SKIPPED title', () => {
  const { markdown } = skippedReport('origin/main');
  assert.match(markdown, /^<!-- healthcare-api-quality-gate -->\n## ⏭️ API quality gate: SKIPPED\n\n/);
  assert.match(markdown, /<sub>healthcare-api-quality-gate /);
});

const consumerDetails = (n, breaking) => Array.from({ length: n }, (_, i) => ({ check: 'consumer', name: `svc-${i + 1}`, endpoint: 'GET /x', breaking, result: `svc-${i + 1} calls GET /x`, hint: 'h' }));

test('impact: breaking changes are the findings, consumers are summarized, summary names capped', () => {
  const { evaluate } = require('../steps/impact');
  const consumers = Array.from({ length: 32 }, (_, i) => ({ name: `svc-${i + 1}`, endpoint: 'GET /x' }));
  const res = evaluate({ api: 'patients-api', consumers, changed: true, changes: [{ change: 'field removed', hint: 'Keep mrn, add the new name next to it' }], command: '' });
  assert.match(res.summary, /32 consumers of patients-api affected \(svc-1, svc-2, svc-3, \+29 more\)$/);
  assert.match(res.details[0].hint, /breaks svc-1; see the breaking changes in this report/);
  const r = aggregate(cfg, { ...green(), impact: { ...res, step: 'impact' } }, {});
  assert.deepEqual(r.report.feedback, [{ step: 'impact', status: 'fail', finding: 'field removed', fix: 'Keep mrn, add the new name next to it' }]);
  assert.ok(r.report.blockers.includes('impact: the change breaks 32 known consumers'));
  assert.match(r.markdown, /- field removed\n\nAffected consumers \(32\): svc-1, svc-2, svc-3, \+29 more\n\nFix: Keep mrn/);
  const one = aggregate(cfg, { ...green(), impact: step('impact', 'fail', 0, [...consumerDetails(1, true), { check: 'breaking-change', result: 'x', hint: 'y' }]) }, {});
  assert.ok(one.report.blockers.includes('impact: the change breaks 1 known consumer'));
  const unknown = aggregate(cfg, { ...green(), impact: step('impact', 'fail', 0, [{ check: 'x', breaking: true }]) }, {});
  assert.ok(unknown.report.blockers.includes('impact: a change breaks at least one known consumer'));
});

test('failed gate: blocking groups first, non-blocking warn groups marked', () => {
  const m = md({
    'ai-readiness': step('ai-readiness', 'warn', 70, [{ result: 'a', hint: 'h' }]),
    'contract-tests': step('contract-tests', 'fail', 30, [{ result: 'b', hint: 'h2' }]),
  });
  assert.ok(m.indexOf('**🔴 contract-tests**') < m.indexOf('**🟠 ai-readiness** (non-blocking)'));
  assert.match(m, /What to fix \(2\)/);
  const ok = md({ 'ai-readiness': step('ai-readiness', 'warn', 70, [{ result: 'a', hint: 'h' }]) });
  assert.doesNotMatch(ok, /non-blocking\)\*\*|\(non-blocking\)$/m);
});

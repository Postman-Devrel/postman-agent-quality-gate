'use strict';
// Step: contract-tests (unit-test analogy).
// Runs the consumers' collection against a mock generated from the CURRENT spec. The collection holds what
// consumers expect, the spec what the API now promises: a drift fails the assertions.
// CLI: postman mock generate ...; postman collection run ... --use-mock ... --output <dir>
// Parsing (YAML run summary) is isolated in parseRunSummary.
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('yaml');
const { result, notAvailable, rerun } = require('../core/step-result');

const id = 'contract-tests';

const MOCK_PORT = 4010; // stored in the generated mock config; `collection run --use-mock` picks its own free port

/**
 * Pure fallback (stdout of the run): failing assertions listed as
 *   " 1.  AssertionError  <test name>" / "<message>" / "at ..." / 'inside "<request>"'.
 */
function parseStdoutFailures(stdout) {
  const lines = String(stdout || '').split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*\d+\.\s+AssertionError\s+(.*?)\s*$/);
    if (!m) return;
    const next = lines.slice(i + 1, i + 5);
    const inside = next.map((l) => l.match(/inside "(.*?)"/)).find(Boolean);
    out.push({ test: m[1], message: (next[0] || '').trim(), request: inside ? inside[1] : undefined });
  });
  return out.slice(0, 10);
}

/**
 * Pure fallback (stdout of the run): the counters table, used when the YAML report is not available
 * (`--output` needs `postman login`). Rows: "| requests | executed | failed |", "| assertions | executed | failed |".
 */
function parseRunStdout(stdout) {
  const row = (name) => {
    const m = String(stdout || '').match(new RegExp(`^\\|\\s*${name}\\s*\\|\\s*(\\d+)\\s*\\|\\s*(\\d+)\\s*\\|`, 'm'));
    return m ? { executed: Number(m[1]), failed: Number(m[2]) } : null;
  };
  const assertions = row('assertions');
  if (!assertions) return null;
  const requests = row('requests') || { failed: 0 };
  return { executed: assertions.executed, failed: assertions.failed, requestErrors: requests.failed, failures: parseStdoutFailures(stdout) };
}

/** Pure: text of *.collection-run-summary.yaml -> counters and failures. */
function parseRunSummary(text) {
  const doc = YAML.parse(text) || {};
  const stats = doc.stats || {};
  const num = (v) => (typeof v === 'number' ? v : 0);
  return {
    executed: num(stats.tests && stats.tests.executed),
    failed: num(stats.tests && stats.tests.failed),
    requestErrors: num(stats.executedRequests && stats.executedRequests.errors),
    failures: (doc.failures || []).map((f) => ({
      request: f.source && f.source.name,
      test: f.error && f.error.test,
      message: f.error && f.error.message,
      name: f.error && f.error.name,
    })),
  };
}

/** Pure: counters -> step result. */
function evaluate(s, { collectionPath, specPath, command, stdout = '' }) {
  if (s.failed > 0 && s.failures.length === 0) s = { ...s, failures: parseStdoutFailures(stdout) };
  const passedCount = Math.max(0, s.executed - s.failed);
  const score = s.executed > 0 ? Math.round((100 * passedCount) / s.executed) : 0;
  const summary = `${passedCount}/${s.executed} assertion(s) pass, ${s.requestErrors} request error(s)`;
  const details = [{ check: 'postman-collection', result: `${s.executed} assertion(s), ${s.failed} failed, ${s.requestErrors} request error(s)` }];
  for (const f of s.failures.slice(0, 10)) {
    details.push({
      check: 'failure',
      result: `${f.request ? f.request + ': ' : ''}${f.test ? f.test + ': ' : ''}${f.message || f.name || 'assertion failed'}`,
      hint: `The spec (${specPath}) and the collection (${collectionPath}) disagree. Either the spec changed something consumers rely on (keep it, add next to it, or version the API), or the collection must be updated on purpose. Then run \`${rerun(id)}\`.`,
    });
  }
  if (s.executed === 0) {
    details.push({ check: 'no-assertion', result: 'The collection ran 0 assertions', hint: `Add pm.test assertions to the requests of ${collectionPath}, then run \`${rerun(id)}\`.` });
  }
  if (s.requestErrors > 0) {
    details.push({ check: 'request-error', result: `${s.requestErrors} request(s) could not be executed`, hint: `Check the URLs and variables of the requests in ${collectionPath} (the base URL variable must be {{baseUrl}}).` });
  }
  const bad = s.failed > 0 || s.requestErrors > 0 || s.executed === 0;
  return result(id, bad ? 'fail' : 'pass', score, summary, details, command);
}

/** Arguments of the collection run. --no-report-events is mandatory: without it the CLI uploads run data to Postman Cloud. */
const runArgs = (collectionPath, mockConfig, outDir) => [
  'collection', 'run', collectionPath, '--use-mock', `{{baseUrl}} mock:${mockConfig}`, ...(outDir ? ['--output', outDir] : []), '--no-report-events',
];

module.exports = {
  id,
  runArgs,
  parseStdoutFailures,
  parseRunStdout,
  supports: ['openapi-3'],
  needsSpec: true,
  needsCollection: true,
  needsCli: true,
  parseRunSummary,
  evaluate,
  run(ctx) {
    const command = `postman collection run "${ctx.collection.path}" --use-mock "{{baseUrl}} mock:<generated mock>" --no-report-events`;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pqg-'));
    try {
      const gen = ctx.exec('postman', ['mock', 'generate', ctx.spec.path, '-n', 'pqg-mock', '--port', String(MOCK_PORT), '-o', path.join(work, 'mock'), '--force'], { cwd: ctx.cwd, env: ctx.env });
      const mockConfig = path.join(work, 'mock', 'config.yaml');
      if (gen.error || !fs.existsSync(mockConfig)) {
        return notAvailable(id, `could not generate a mock from ${ctx.spec.path}: ${(gen.stderr || gen.stdout || (gen.error && gen.error.message) || '').trim().split('\n')[0]}`, command);
      }
      const run = ctx.exec('postman', runArgs(ctx.collection.path, mockConfig, path.join(work, 'run')), { cwd: ctx.cwd, env: ctx.env });
      const runDir = path.join(work, 'run');
      const file = fs.existsSync(runDir) && fs.readdirSync(runDir).find((f) => f.endsWith('collection-run-summary.yaml'));
      let summary;
      if (file) {
        summary = parseRunSummary(fs.readFileSync(path.join(runDir, file), 'utf8'));
      } else {
        // `--output` needs `postman login`. Without it, read the counters table of the run instead.
        // NOT degraded: it is the same data (executed/failed assertions, request errors, failing tests), only read
        // from stdout instead of the YAML report. The check is not weakened, so no `degraded` flag.
        const plain = ctx.exec('postman', runArgs(ctx.collection.path, mockConfig, null), { cwd: ctx.cwd, env: ctx.env });
        summary = parseRunStdout(plain.stdout + '\n' + plain.stderr);
        if (!summary) return notAvailable(id, `collection run produced no report: ${(plain.stderr || plain.stdout || '').trim().split('\n')[0]}`, command);
        run.stdout = plain.stdout;
      }
      return evaluate(summary, { collectionPath: ctx.collection.path, specPath: ctx.spec.path, command, stdout: run.stdout });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
};

'use strict';
// Step: contract-lint (linter analogy). Lints the spec with the Postman governance rules.
// CLI: postman spec lint <spec> -o json --no-report-events   (parsing isolated in parseLint)
const { plural, result, notAvailable, rerun, applyDegraded } = require('../core/step-result');

const id = 'contract-lint';

const severityOf = (v) => {
  const s = String(v.severity).toLowerCase();
  if (s === 'error' || s === '0') return 'error';
  if (s === 'warning' || s === '1') return 'warning';
  return 'other';
};

/**
 * Accepted exceptions: a human decision recorded in the config. An exception matches a violation when `path` is equal
 * to the violation's path and `issue` is a case-insensitive substring of its issue text. The CLI output has no rule id
 * ("issue type" is only Syntax or Governance), so the issue text is the stable handle.
 */
const matches = (ex, v) => ex.path === v.path && String(v.issue ?? '').toLowerCase().includes(ex.issue.toLowerCase());

/**
 * Pure: stdout of the CLI -> step result. `specPath` is the resolved spec, cited in hints.
 * `exceptions` are the configured accepted findings; `opts.checkStale === false` skips the stale-exception check
 * (a degraded run did not apply every rule, so an unmatched exception proves nothing).
 */
function parseLint(stdout, specPath, command, exceptions = [], opts = {}) {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    return notAvailable(id, 'lint produced no JSON output', command);
  }
  if (!json || !Array.isArray(json.violations)) return notAvailable(id, 'lint produced no JSON output', command);

  const counts = exceptions.map(() => 0);
  const accepted = [];
  const kept = [];
  for (const v of json.violations) {
    const i = exceptions.findIndex((ex) => matches(ex, v));
    if (i < 0) kept.push(v);
    else {
      counts[i] += 1;
      accepted.push({ ...v, check: 'lint', accepted: true, reason: exceptions[i].reason, result: `accepted ${v.severity} at ${v.path ?? '?'}: ${v.issue ?? ''}` });
    }
  }

  const details = kept.map((v) => ({
    ...v,
    check: 'lint',
    result: `${v.severity} at ${v.path ?? '?'}: ${v.issue ?? ''}`,
    hint: `Fix ${specPath} at ${v.path ?? '?'} (line ${v['line number'] ?? '?'}): ${v.issue ?? ''} Then run \`${rerun(id)}\`.`,
  }));
  const kinds = details.map(severityOf);
  const errors = kinds.filter((k) => k === 'error').length;
  const warnings = kinds.filter((k) => k === 'warning').length;
  const other = details.length - errors - warnings;

  // Each error costs 40 points, each warning 10, anything else 2.
  const score = Math.max(0, 100 - 40 * errors - 10 * warnings - 2 * other);
  let summary = `${plural(errors, "error")}, ${plural(warnings, "warning")}, ${other} other`;
  const stale = opts.checkStale === false ? [] : exceptions.filter((_, i) => counts[i] === 0);
  const res = errors > 0 ? result(id, 'fail', score, summary, details, command)
    : warnings > 0 ? result(id, 'warn', score, summary, details, command)
      : result(id, 'pass', 100, details.length ? summary : 'No lint issue', details, command);
  if (exceptions.length) {
    res.exceptions = exceptions.map((ex, i) => ({ ...ex, matched: counts[i] }));
    res.accepted = accepted;
    if (accepted.length) res.summary += ` (${accepted.length} accepted by exception)`;
    for (const ex of stale) {
      res.details.push({
        check: 'exceptions',
        stale: true,
        result: `Stale lint exception: nothing matches path "${ex.path}" with issue "${ex.issue}"`,
        hint: `Remove the stale exception (path "${ex.path}", issue "${ex.issue}") from contract-lint.exceptions in the gate config: the finding it accepted no longer exists. This is a human decision.`,
      });
    }
    if (stale.length && res.status === 'pass') {
      res.status = 'warn';
      res.score = Math.min(res.score, 90);
      res.summary += `, ${plural(stale.length, "stale exception")}`;
    }
  }
  return res;
}

/** Pure: did the CLI refuse because there is no login? */
const needsLogin = (r) => /requires you to be logged in/i.test(`${r.stdout}\n${r.stderr}`);

module.exports = {
  id,
  needsLogin,
  supports: ['openapi-3'],
  needsSpec: true,
  needsCli: true,
  parseLint,
  run(ctx) {
    const args = ['spec', 'lint', ctx.spec.path, '-o', 'json', '--no-report-events'];
    const command = `postman ${args.join(' ')}`;
    const exceptions = (ctx.config && ctx.config['contract-lint'] && ctx.config['contract-lint'].exceptions) || [];
    // The exit code is ignored: the severities drive the result.
    const r = ctx.exec('postman', args, { cwd: ctx.cwd, env: ctx.env });
    if (r.error) return notAvailable(id, `postman CLI failed to start: ${r.error.message}`, command);
    // Governance rules need a login. Without one the CLI refuses: lint the syntax only and say so.
    if (needsLogin(r)) {
      const syntaxArgs = [...args, '--issueType', 'syntax'];
      const syntaxCommand = `postman ${syntaxArgs.join(' ')}`;
      const s = ctx.exec('postman', syntaxArgs, { cwd: ctx.cwd, env: ctx.env });
      const res = parseLint(s.stdout, ctx.spec.path, syntaxCommand, exceptions, { checkStale: false });
      if (res.status !== 'not_available') {
        res.degraded = 'governance rules skipped: not logged in to Postman (syntax rules only)';
        res.summary += ' (syntax rules only: not logged in to Postman, governance rules skipped)';
        applyDegraded(res); // never a pass; a syntax error stays a fail
      }
      return res;
    }
    return parseLint(r.stdout, ctx.spec.path, command, exceptions);
  },
};

'use strict';
// Step: contract-lint (linter analogy). Lints the spec with the Postman governance rules.
// CLI: postman spec lint <spec> -o json --no-report-events   (parsing isolated in parseLint)
const { result, notAvailable, rerun, applyDegraded } = require('../core/step-result');

const id = 'contract-lint';

const severityOf = (v) => {
  const s = String(v.severity).toLowerCase();
  if (s === 'error' || s === '0') return 'error';
  if (s === 'warning' || s === '1') return 'warning';
  return 'other';
};

/** Pure: stdout of the CLI -> step result. `specPath` is the resolved spec, cited in hints. */
function parseLint(stdout, specPath, command) {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    return notAvailable(id, 'lint produced no JSON output', command);
  }
  if (!json || !Array.isArray(json.violations)) return notAvailable(id, 'lint produced no JSON output', command);

  const details = json.violations.map((v) => ({
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
  const summary = `${errors} error(s), ${warnings} warning(s), ${other} other`;
  if (errors > 0) return result(id, 'fail', score, summary, details, command);
  if (warnings > 0) return result(id, 'warn', score, summary, details, command);
  return result(id, 'pass', 100, 'No lint issue', details, command);
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
    // The exit code is ignored: the severities drive the result.
    const r = ctx.exec('postman', args, { cwd: ctx.cwd, env: ctx.env });
    if (r.error) return notAvailable(id, `postman CLI failed to start: ${r.error.message}`, command);
    // Governance rules need a login. Without one the CLI refuses: lint the syntax only and say so.
    if (needsLogin(r)) {
      const syntaxArgs = [...args, '--issueType', 'syntax'];
      const syntaxCommand = `postman ${syntaxArgs.join(' ')}`;
      const s = ctx.exec('postman', syntaxArgs, { cwd: ctx.cwd, env: ctx.env });
      const res = parseLint(s.stdout, ctx.spec.path, syntaxCommand);
      if (res.status !== 'not_available') {
        res.degraded = 'governance rules skipped: not logged in to Postman (syntax rules only)';
        res.summary += ' (syntax rules only: not logged in to Postman, governance rules skipped)';
        applyDegraded(res); // never a pass; a syntax error stays a fail
      }
      return res;
    }
    return parseLint(r.stdout, ctx.spec.path, command);
  },
};

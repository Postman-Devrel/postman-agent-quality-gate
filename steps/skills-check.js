'use strict';
// Step: skills-check (dependency-check analogy).
// Are the Postman skills committed in the repo up to date? Outdated skills are stale instructions for agents.
// CLI: postman skills status --json   (parsing is isolated in parseSkillsStatus)
const { result, notAvailable } = require('../core/step-result');

const id = 'skills-check';
const COMMAND = 'postman skills status --json';

/**
 * Pure: stdout of the CLI -> step result. CLI 1.76.0 returns only { state, message }; documented states are
 * `current` and `behind`. Anything else (e.g. `foreign`) is not_available with the CLI message.
 */
function parseSkillsStatus(stdout) {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    return notAvailable(id, 'skills status returned no JSON', COMMAND);
  }
  const state = json.state || 'error';
  if (state === 'current') return result(id, 'pass', 100, 'Skills match the published version', [], COMMAND);
  if (state === 'behind') {
    return result(id, 'warn', 50, "Skills are behind the published version: run 'postman skills update'",
      [{ check: 'skills', result: json.message || 'Skills are missing or out of date', hint: 'Run `postman skills update` and commit the result.' }], COMMAND);
  }
  return notAvailable(id, `skills status returned '${state}': ${json.message || json.error || 'no output'}`, COMMAND);
}

module.exports = {
  id,
  supports: ['*'], // does not read the spec
  needsSpec: false,
  needsCli: true,
  parseSkillsStatus,
  run(ctx) {
    const r = ctx.exec('postman', ['skills', 'status', '--json'], { cwd: ctx.cwd, env: ctx.env });
    if (r.error) return notAvailable(id, `postman CLI failed to start: ${r.error.message}`, COMMAND);
    return parseSkillsStatus(r.stdout);
  },
};

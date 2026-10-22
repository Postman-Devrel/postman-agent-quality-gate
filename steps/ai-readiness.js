'use strict';
// Step: ai-readiness (maintainability analogy). How well can an agent discover, understand and call this API?
// CLI: postman spec ai-readiness <spec> -o json   (parsing isolated in parseAiReadiness)
const { result, notAvailable, rerun } = require('../core/step-result');

const id = 'ai-readiness';

/** Pure: stdout of the CLI -> step result. Default thresholds: >= 80 pass, 60-79 warn, < 60 fail (config ai_readiness). */
function parseAiReadiness(stdout, specPath, command, thresholds = { pass_min: 80, warn_min: 60 }) {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    return notAvailable(id, 'ai-readiness returned no JSON', command);
  }
  const score = json && json.readiness && json.readiness.score_0_100;
  if (typeof score !== 'number') return notAvailable(id, 'ai-readiness returned no score', command);

  const details = (json.recommendations || []).map((rec) => ({
    check: 'recommendation',
    result: rec,
    hint: `Update the descriptions or examples in ${specPath} to address this, then run \`${rerun(id)}\`.`,
  }));
  const summary = `AI readiness ${score}/100 (${json.readiness.bucket})`;
  const status = score >= thresholds.pass_min ? 'pass' : score >= thresholds.warn_min ? 'warn' : 'fail';
  return result(id, status, score, summary, details, command);
}

module.exports = {
  id,
  supports: ['openapi-3'],
  needsSpec: true,
  needsCli: true,
  parseAiReadiness,
  run(ctx) {
    const args = ['spec', 'ai-readiness', ctx.spec.path, '-o', 'json'];
    const command = `postman ${args.join(' ')}`;
    const r = ctx.exec('postman', args, { cwd: ctx.cwd, env: ctx.env });
    if (r.error) return notAvailable(id, `postman CLI failed to start: ${r.error.message}`, command);
    return parseAiReadiness(r.stdout, ctx.spec.path, command, ctx.config.ai_readiness);
  },
};

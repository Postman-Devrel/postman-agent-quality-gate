'use strict';
// Step: impact (no Sonar equivalent: this is the point). Who depends on this API?
// 1. Ask the Context Graph for the consumers of impact.api.
// 2. Compare the spec with the base ref (adapter by spec family) and list breaking changes.
// 3. A breaking change with known consumers is a blocker (details carry "breaking": true).
// CLI (>= 1.76.0 has .result.structured, used first; the JSON-only text answer is the fallback):
// postman context-graph ask "<question>" --wait --json --timeout 120   (answer parsing in parseConsumers)
// Limits: `context-graph ask` answers in free text, so the prompt forces a JSON-only answer; "breaking" is a
// structural heuristic on the diff, not a Context Graph verdict.
const fs = require('fs');
const path = require('path');
const { plural, result, notAvailable } = require('../core/step-result');
const openapiDiff = require('./adapters/openapi/contract-diff');

const id = 'impact';

const question = (api) =>
  `List the services that consume ${api} through the Context Graph. Reply with ONLY a JSON array, no prose, no code fence. Each item: {"name": string, "endpoint": string, "protocol": string, "confidence": number between 0 and 1}. Reply [] if there is none.`;

/** Consumers from `.result.structured.results[].data.dependencies[]` (typed query), or null when absent. */
function consumersFromStructured(json) {
  const results = json && json.result && json.result.structured && json.result.structured.results;
  if (!Array.isArray(results)) return null;
  const out = [];
  let seen = false;
  for (const r of results) {
    const deps = r && r.data && r.data.dependencies;
    if (!Array.isArray(deps)) continue;
    seen = true;
    for (const d of deps) {
      const name = d && d.api && d.api.name;
      if (!name) continue;
      out.push({ name, endpoint: Array.isArray(d.endpoints_called) ? d.endpoints_called.join(', ') : (d.endpoints_called || ''), protocol: d.protocol || '', confidence: d.confidence });
    }
  }
  return seen ? out : null;
}

/** Consumers from the free-text answer, which the prompt forces to be a JSON array, or null when unusable. */
function consumersFromAnswer(json) {
  let answer = json && json.result && json.result.answer;
  if (typeof answer !== 'string') return null;
  answer = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const arr = JSON.parse(answer);
    return Array.isArray(arr) ? arr.filter((c) => c && typeof c === 'object') : null;
  } catch {
    return null;
  }
}

/**
 * Pure: stdout of `context-graph ask --json` -> array of consumers, or null when the answer is unusable.
 * The structured typed query is used first; the text answer is the fallback when it is absent or empty.
 */
function parseConsumers(stdout) {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const structured = consumersFromStructured(json);
  if (structured && structured.length > 0) return structured;
  return consumersFromAnswer(json) ?? structured;
}

/** Breaking changes between two versions of a spec, by adapter. Unsupported types never reach here. */
function breakingChanges(specType, baseText, headText) {
  if (specType === 'openapi-3') return openapiDiff.diffText(baseText, headText);
  throw new Error(`no diff adapter for ${specType}`);
}

/** Base ref: GATE_BASE_REF, else the remote default branch, else origin/main|master, else HEAD. */
function resolveBaseRef(ctx) {
  const git = (...a) => ctx.exec('git', a, { cwd: ctx.cwd, env: ctx.env });
  const ok = (ref) => git('rev-parse', '--verify', '-q', ref).status === 0;
  const wanted = ctx.env.GATE_BASE_REF;
  if (wanted && ok(wanted)) return wanted;
  const head = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (head.status === 0 && head.stdout.trim() && ok(head.stdout.trim())) return head.stdout.trim();
  for (const c of ['origin/main', 'origin/master']) if (ok(c)) return c;
  return 'HEAD';
}

/** Pure: assemble the result from consumers and changes. */
function evaluate({ api, consumers, changed, changes, command }) {
  const count = consumers.length;
  const breaking = changes.length > 0;
  const details = [
    ...consumers.map((c) => ({
      ...c,
      api,
      breaking: breaking && count > 0,
      check: 'consumer',
      result: `${c.name} calls ${c.endpoint ?? '?'}`,
      hint: breaking && count > 0 ? `This change breaks ${c.name}; see the breaking changes in this report.` : 'Known consumer, no action.',
    })),
    ...changes.map((c) => ({ check: 'breaking-change', result: c.change, hint: c.hint })),
  ];
  const shown = consumers.slice(0, 3).map((c) => c.name).join(', ');
  const names = count > 3 ? `${shown}, +${count - 3} more` : shown;
  if (breaking && count > 0) return result(id, 'fail', 0, `Breaking contract change (${changes[0].change}): ${plural(count, "consumer")} of ${api} affected (${names})`, details, command);
  if (breaking) return result(id, 'warn', 60, `Breaking contract change, but the Context Graph knows no consumer of ${api}`, details, command);
  if (changed) return result(id, 'pass', 100, `Additive contract change; ${plural(count, "known consumer")} of ${api}`, details, command);
  return result(id, 'pass', 100, `Contract unchanged; ${plural(count, "known consumer")} of ${api}`, details, command);
}

module.exports = {
  id,
  supports: ['openapi-3'],
  needsSpec: true,
  needsCli: true,
  parseConsumers,
  breakingChanges,
  resolveBaseRef,
  evaluate,
  question,
  run(ctx) {
    const api = ctx.config.impact && ctx.config.impact.api;
    const command = `postman context-graph ask "<list the consumers of ${api || '<impact.api>'} as JSON>" --wait --json`;
    if (!api) return notAvailable(id, 'impact.api is not set in the config file (name of the API in the Postman Context Graph)', command);

    // 1. Consumers. The answer comes from an LLM: an empty list is retried (up to 3 asks), a missing consumer
    // would otherwise silently turn a breaking change into a pass.
    let consumers = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = ctx.exec('postman', ['context-graph', 'ask', question(api), '--wait', '--json', '--timeout', '120'], { cwd: ctx.cwd, env: ctx.env });
      if (r.error) return notAvailable(id, `postman CLI failed to start: ${r.error.message}`, command);
      consumers = parseConsumers(r.stdout);
      if (consumers && consumers.length > 0) break;
      ctx.log(`attempt ${attempt}: no consumer returned`);
    }
    if (!consumers) return notAvailable(id, 'Context Graph gave no usable answer (not logged in, or API not ingested)', command);

    // 2. Does this change touch the spec, and is it breaking?
    const git = (...a) => ctx.exec('git', a, { cwd: ctx.cwd, env: ctx.env });
    if (git('rev-parse', '--verify', '-q', 'HEAD').status !== 0) return notAvailable(id, 'not a git repository with a commit: cannot compare the spec with its base', command);
    const base = resolveBaseRef(ctx);
    const mb = git('merge-base', base, 'HEAD');
    const baseCommit = mb.status === 0 && mb.stdout.trim() ? mb.stdout.trim() : base;
    const headText = fs.readFileSync(ctx.spec.abs, 'utf8');
    // The spec may be a symlink (git stores the link, not the target): address the real file from the repo root.
    const top = git('rev-parse', '--show-toplevel').stdout.trim() || ctx.cwd;
    let rel = ctx.spec.path;
    try { rel = path.relative(fs.realpathSync(top), fs.realpathSync(ctx.spec.abs)); } catch { /* keep the declared path */ }
    const shown = git('show', `${baseCommit}:${rel.split(path.sep).join('/')}`);
    let changed = false;
    let changes = [];
    if (shown.status !== 0) {
      changed = true; // the spec does not exist on the base: a new spec is additive
    } else if (shown.stdout !== headText) {
      changed = true;
      try {
        changes = breakingChanges(ctx.spec.type, shown.stdout, headText);
      } catch (e) {
        return notAvailable(id, `cannot compare the spec with ${base}: ${e.message}`, command);
      }
    }
    return evaluate({ api, consumers, changed, changes, command });
  },
};

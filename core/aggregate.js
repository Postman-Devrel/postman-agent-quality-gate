'use strict';
// Aggregation: step results -> composite score, rating, blockers, feedback, report.json and report.md.
// This is the only place that decides pass or fail.
const { applyDegraded } = require('./step-result');
const { LETTERS, REPORT_MARKER, SCHEMA_VERSION, GATE_VERSION, RUNNER_COMMAND } = require('./constants');

const ICON = { pass: '🟢', warn: '🟠', fail: '🔴', not_available: '⚪' };
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

const ratingFor = (cfg, score) => LETTERS.find((l) => cfg.rating[l] !== undefined && score >= cfg.rating[l]) || 'E';

function missingResult(step) {
  return { step, status: 'not_available', score: null, summary: 'NOT_AVAILABLE: no result file, the step did not run', details: [], command: '' };
}

/**
 * @param cfg      validated config
 * @param results  map step id -> result (steps without an entry are "did not run")
 * @param meta     { spec, collection, cli_version }
 */
function aggregate(cfg, results, meta = {}) {
  const steps = cfg.steps.map((id) => applyDegraded({ ...(results[id] || missingResult(id)), step: id }));

  // Composite score: not_available steps never count (their weight is re-distributed).
  const counted = steps.filter((s) => s.status !== 'not_available' && typeof s.score === 'number' && (cfg.weights[s.step] || 0) > 0);
  const totalWeight = counted.reduce((sum, s) => sum + cfg.weights[s.step], 0);
  const score = totalWeight ? Math.round(counted.reduce((sum, s) => sum + s.score * cfg.weights[s.step], 0) / totalWeight) : 0;
  // A required step that did not run caps the rating at E: a high score on the steps that did run must not look good.
  const missingRequired = cfg.required_steps.filter((id) => steps.some((x) => x.step === id && x.status === 'not_available'));
  const rating = totalWeight && !missingRequired.length ? ratingFor(cfg, score) : 'E';

  // Blockers: declared per step in the config, plus required steps that are not available.
  const blockers = [];
  for (const s of steps) {
    const rule = cfg.blockers[s.step];
    if (rule === 'on_fail' && s.status === 'fail') blockers.push(`${s.step} failed: ${s.summary}`);
    else if (rule === 'on_warn' && (s.status === 'fail' || s.status === 'warn')) blockers.push(`${s.step} is ${s.status}: ${s.summary}`);
    else if (rule === 'on_breaking' && (s.details || []).some((d) => d && d.breaking === true)) blockers.push(`${s.step}: a change breaks at least one known consumer`);
  }
  for (const id of cfg.required_steps) {
    const s = steps.find((x) => x.step === id);
    if (s && s.status === 'not_available') blockers.push(`Required step ${id} is not available: ${String(s.summary).replace(/^NOT_AVAILABLE:\s*/, '')}`);
  }
  if (!counted.length) blockers.push('No step produced a usable result');

  const passed = blockers.length === 0 && LETTERS.indexOf(rating) <= LETTERS.indexOf(cfg.pass_rating);

  // Feedback for the coding agent: one entry per finding of a step that is not green.
  const feedback = [];
  for (const s of steps.filter((x) => x.status === 'warn' || x.status === 'fail')) {
    const items = (s.details || []).filter((d) => d && (d.hint || d.result));
    const useful = items.filter((d) => d.hint);
    for (const d of (useful.length ? useful : [{ result: s.summary }]).slice(0, 8)) {
      feedback.push({ step: s.step, status: s.status, finding: d.result || s.summary, fix: d.hint || 'See the step summary.' });
    }
  }

  for (const s of steps.filter((x) => x.degraded)) {
    feedback.push({ step: s.step, status: s.status, finding: `${s.step} ran degraded: ${s.degraded}`, fix: 'Run the gate with the full capability (for example set POSTMAN_API_KEY) so the skipped check runs.' });
  }

  const report = {
    schema_version: SCHEMA_VERSION,
    gate_version: GATE_VERSION,
    cli_version: meta.cli_version || null,
    spec: meta.spec ? { path: meta.spec.path, type: meta.spec.type } : null,
    collection: meta.collection ? { path: meta.collection.path } : null,
    passed,
    score,
    rating,
    headline: missingRequired.length
      ? `rating E, required step${missingRequired.length > 1 ? 's' : ''} ${missingRequired.join(', ')} did not run (${score}/100 on the steps that ran)`
      : null,
    blockers,
    feedback,
    steps: steps.map(({ step, status, score: sc, degraded }) => ({ step, status, score: sc, ...(degraded ? { degraded } : {}) })),
  };
  return { report, markdown: renderMarkdown(cfg, report, steps) };
}

function renderMarkdown(cfg, report, steps) {
  const { passed, rating, score, blockers, feedback, headline } = report;
  const rows = steps.map((s) => {
    const na = s.status === 'not_available';
    return `| ${ICON[s.status] || '⚪'} ${s.step} | ${s.status} | ${na ? '–' : s.score} | ${na ? '–' : cfg.weights[s.step]} | ${cell(s.summary)} | ${s.command ? '`' + cell(s.command) + '`' : ''} |`;
  });
  const lines = [
    REPORT_MARKER,
    `## ${passed ? '✅' : '❌'} Postman agent quality gate: ${headline || `rating ${rating} (${score}/100)`}`,
    '',
    `**${passed ? 'PASSED' : 'FAILED'}**. Required: rating ${cfg.pass_rating} or better and no blocker.`,
    '',
    report.spec ? `Spec: \`${report.spec.path}\` (${report.spec.type})${report.collection ? ` · Collection: \`${report.collection.path}\`` : ''}` : '',
    '',
    '| Step | Status | Score | Weight | Summary | Command |',
    '|------|--------|------:|-------:|---------|---------|',
    ...rows,
    '',
  ];
  if (blockers.length) lines.push('### Blockers', '', ...blockers.map((b) => `- ${b}`), '');
  const skipped = steps.filter((s) => s.status === 'not_available');
  if (skipped.length) {
    lines.push('### Not available (excluded from the score, never counted as a pass)', '', ...skipped.map((s) => `- ⚪ **${s.step}**: ${s.summary}`), '');
  }
  const degraded = steps.filter((s) => s.degraded);
  if (degraded.length) {
    lines.push('### Degraded (the check ran weakened: at best a warning, score capped, never a full pass)', '', ...degraded.map((s) => `- 🟠 **${s.step}**: ${s.degraded}`), '');
  }
  if (feedback.length) {
    lines.push('### What to fix (for the coding agent)', '', ...feedback.map((f, i) => `${i + 1}. **${f.step}** (${f.status}): ${cell(f.finding)}  \n   Fix: ${cell(f.fix)}`), '');
  }
  for (const s of steps.filter((x) => (x.status === 'warn' || x.status === 'fail') && (x.details || []).length)) {
    lines.push(`<details><summary>${ICON[s.status]} ${s.step}: details</summary>`, '', '```json', JSON.stringify(s.details, null, 2).slice(0, 3000), '```', '', '</details>', '');
  }
  lines.push(`<sub>postman-agent-quality-gate ${GATE_VERSION}${report.cli_version ? ` · Postman CLI ${report.cli_version}` : ''} · re-run a step: \`${RUNNER_COMMAND} run <step>\`</sub>`, '');
  return lines.join('\n');
}

module.exports = { aggregate, ratingFor, renderMarkdown };

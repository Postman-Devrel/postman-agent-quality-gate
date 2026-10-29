'use strict';
// Aggregation: step results -> composite score, rating, blockers, feedback, report.json and report.md.
// This is the only place that decides pass or fail.
const { applyDegraded } = require('./step-result');
const { QUALITY_STEPS, indexFromScores, scoresOf, computeDelta, changeRisk, configHash, ratchet, deltaText, riskText } = require('./quality');
const { LETTERS, REPORT_MARKER, SCHEMA_VERSION, GATE_VERSION, RUNNER_COMMAND } = require('./constants');

const ICON = { pass: '🟢', warn: '🟠', fail: '🔴', not_available: '⚪' };
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Short name of the base for the headline: origin/main -> main, a full SHA -> 7 characters. */
const baseLabel = (ref) => (/^[0-9a-f]{40}$/.test(ref || '') ? ref.slice(0, 7) : String(ref || 'base').replace(/^origin\//, ''));

const ratingFor = (cfg, score) => LETTERS.find((l) => cfg.rating[l] !== undefined && score >= cfg.rating[l]) || 'E';

function missingResult(step) {
  return { step, status: 'not_available', score: null, summary: 'NOT_AVAILABLE: no result file, the step did not run', details: [], command: '' };
}

/**
 * @param cfg      validated config
 * @param results  map step id -> result (steps without an entry are "did not run")
 * @param meta     { spec, collection, cli_version, commit, baseline } (baseline: see core/baseline.js)
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

  // Quality delta against the base commit, change risk, optional ratchet.
  const headScores = scoresOf(steps);
  const qualityIndex = indexFromScores(cfg, headScores);
  const baseline = meta.baseline || { ref: null, sha: null, source: 'none', gate_version: null, quality_index: null, steps: null, reason: 'no baseline was computed' };
  const label = baseLabel(baseline.ref);
  const delta = computeDelta(cfg, headScores, baseline);
  const risk = changeRisk(steps);
  const ratchetResult = ratchet(cfg, delta, label);
  if (ratchetResult.blocker) blockers.push(ratchetResult.blocker);

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

  const acceptedCount = steps.reduce((n, s) => n + (Array.isArray(s.accepted) ? s.accepted.length : 0), 0);
  const acceptedNote = `${acceptedCount} accepted lint exception${acceptedCount > 1 ? 's' : ''}`;
  const verdict = missingRequired.length
    ? `rating E, required step${missingRequired.length > 1 ? 's' : ''} ${missingRequired.join(', ')} did not run (${score}/100 on the steps that ran)`
    : acceptedCount
      ? (passed ? `PASSED with ${acceptedNote} (rating ${rating}, ${score}/100)` : `rating ${rating} (${score}/100), ${acceptedNote}`)
      : (passed ? `PASSED (rating ${rating}, ${score}/100)` : `rating ${rating} (${score}/100)`);
  const headline = `${verdict} · ${deltaText(qualityIndex, delta, label)} · ${riskText(risk)}`;
  const report = {
    schema_version: SCHEMA_VERSION,
    gate_version: GATE_VERSION,
    cli_version: meta.cli_version || null,
    commit: meta.commit || null,
    config_hash: configHash(cfg),
    spec: meta.spec ? { path: meta.spec.path, type: meta.spec.type } : null,
    collection: meta.collection ? { path: meta.collection.path } : null,
    passed,
    score,
    rating,
    headline,
    quality_index: qualityIndex,
    baseline,
    delta: delta ? { points: delta.points, percent: delta.percent, stable: delta.stable } : null,
    risk: { breaking: risk.breaking, consumers: risk.consumers },
    ...(cfg.no_regression ? { no_regression: { max_drop: ratchetResult.max_drop, status: ratchetResult.status } } : {}),
    blockers,
    feedback,
    steps: steps.map(({ step, status, score: sc, degraded, accepted }) => ({
      step,
      status,
      score: sc,
      ...(degraded ? { degraded } : {}),
      ...(Array.isArray(accepted) ? { accepted_exceptions: accepted.length } : {}),
    })),
  };
  return { report, markdown: renderMarkdown(cfg, report, steps, { delta, label }) };
}

/** What the baseline says (or why there is none), and the ratchet when one is configured. */
function qualityLines(report, label, delta) {
  const b = report.baseline;
  const lines = [];
  if (report.quality_index === null) lines.push('API quality index: not available (no scored step among contract-lint, contract-tests, coverage, ai-readiness).');
  else if (b && b.source !== 'none' && delta) {
    lines.push(`API quality index (contract-lint, contract-tests, coverage, ai-readiness): **${delta.head}** against **${delta.base}** on \`${label}\` @ \`${String(b.sha).slice(0, 7)}\` (baseline: ${b.source === 'artifact' ? 'gate report of that commit' : 'steps re-run on that commit'}).`);
  } else {
    lines.push(`API quality index: ${report.quality_index}. Not comparable with \`${label}\`: ${(b && b.reason) || 'no baseline'}.`);
  }
  if (report.no_regression) {
    const { max_drop: max, status } = report.no_regression;
    lines.push(status === 'not_comparable' ? `Ratchet (no_regression.max_drop ${max}): not enforced, no comparable baseline.` : `Ratchet (no_regression.max_drop ${max}): ${status === 'violated' ? 'violated' : 'respected'}.`);
  }
  return lines.flatMap((l) => [l, '']);
}

function renderMarkdown(cfg, report, steps, quality = {}) {
  const { passed, rating, score, blockers, feedback, headline } = report;
  const { delta, label } = quality;
  const baseSteps = report.baseline && report.baseline.steps;
  const withBase = Boolean(delta);
  const baseCell = (s) => {
    if (!withBase || !QUALITY_STEPS.includes(s.step)) return '–';
    const b = baseSteps[s.step];
    if (typeof b !== 'number' || typeof s.score !== 'number') return '–';
    return b === s.score ? `${b} → ${s.score}` : `${b} → ${s.score} (${s.score > b ? '+' : '−'}${Math.abs(s.score - b)})`;
  };
  const rows = steps.map((s) => {
    const na = s.status === 'not_available';
    return `| ${ICON[s.status] || '⚪'} ${s.step} | ${s.status} | ${na ? '–' : s.score} |${withBase ? ` ${baseCell(s)} |` : ''} ${na ? '–' : cfg.weights[s.step]} | ${cell(s.summary)} | ${s.command ? '`' + cell(s.command) + '`' : ''} |`;
  });
  const lines = [
    REPORT_MARKER,
    `## ${passed ? '✅' : '❌'} API quality gate: ${headline || `rating ${rating} (${score}/100)`}`,
    '',
    `**${passed ? 'PASSED' : 'FAILED'}**. Required: rating ${cfg.pass_rating} or better and no blocker.`,
    '',
    report.spec ? `Spec: \`${report.spec.path}\` (${report.spec.type})${report.collection ? ` · Collection: \`${report.collection.path}\`` : ''}` : '',
    '',
    ...qualityLines(report, label, delta),
    '',
    `| Step | Status | Score |${withBase ? ` vs ${label} |` : ''} Weight | Summary | Command |`,
    `|------|--------|------:|${withBase ? '-------:|' : ''}-------:|---------|---------|`,
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
  const acceptedRows = steps.flatMap((s) => (Array.isArray(s.accepted) ? s.accepted : []).map((a) => ({ step: s.step, ...a })));
  if (acceptedRows.length) {
    lines.push(
      '### Accepted exceptions (human decisions)',
      '',
      'These findings are removed from the score and the blockers because a person accepted them in the gate config. They are still real findings.',
      '',
      '| Step | Finding | Path | Reason |',
      '|------|---------|------|--------|',
      ...acceptedRows.map((a) => `| ${a.step} | ${cell(`${a.severity}: ${a.issue ?? ''}`)} | \`${cell(a.path)}\` | ${cell(a.reason)} |`),
      '',
    );
  }
  if (feedback.length) {
    lines.push('### What to fix (for the coding agent)', '', ...feedback.map((f, i) => `${i + 1}. **${f.step}** (${f.status}): ${cell(f.finding)}  \n   Fix: ${cell(f.fix)}`), '');
  }
  for (const s of steps.filter((x) => (x.status === 'warn' || x.status === 'fail') && (x.details || []).length)) {
    lines.push(`<details><summary>${ICON[s.status]} ${s.step}: details</summary>`, '', '```json', JSON.stringify(s.details, null, 2).slice(0, 3000), '```', '', '</details>', '');
  }
  lines.push(`<sub>healthcare-api-quality-gate ${GATE_VERSION}${report.cli_version ? ` · Postman CLI ${report.cli_version}` : ''} · re-run a step: \`${RUNNER_COMMAND} run <step>\`</sub>`, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = { aggregate, ratingFor, renderMarkdown };

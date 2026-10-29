'use strict';
// Aggregation: step results -> composite score, rating, blockers, feedback, report.json and report.md.
// This is the only place that decides pass or fail.
const { applyDegraded, plural } = require('./step-result');
const { QUALITY_STEPS, indexFromScores, scoresOf, computeDelta, changeRisk, configHash, ratchet, deltaText, riskText, signed } = require('./quality');
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
  const more = {}; // findings cut by the per-step cap: step -> count (report.json keeps the capped list)
  for (const s of steps.filter((x) => x.status === 'warn' || x.status === 'fail')) {
    const items = (s.details || []).filter((d) => d && (d.hint || d.result));
    const useful = items.filter((d) => d.hint);
    const found = useful.length ? useful : [{ result: s.summary }];
    if (found.length > 8) more[s.step] = found.length - 8;
    for (const d of found.slice(0, 8)) {
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
    ...(meta.run_url ? { run_url: meta.run_url } : {}),
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
  return { report, markdown: renderMarkdown(cfg, report, steps, { delta, label, more, risk }) };
}

const oneLine = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').trim();
const MINUS = '−';

/** "**🟰 API quality is unchanged from `main`**", then the reason when there is no comparison. */
function qualityHeader(report, label, delta) {
  const b = report.baseline;
  if (report.quality_index === null) return ['**API quality: not available**', 'No scored step among contract-lint, contract-tests, coverage, ai-readiness.'];
  if (b && b.source !== 'none' && delta) {
    const abs = Math.abs(delta.points);
    if (delta.stable) return [`**🟰 API quality is unchanged from \`${label}\`**`];
    const up = delta.points > 0;
    const amount = delta.percent !== null ? `${Math.abs(delta.percent)} %` : `${abs} ${abs === 1 ? 'pt' : 'pts'}`;
    return [`**${up ? '⬆️' : '⬇️'} API quality is ${up ? 'raised' : 'lowered'} by ${amount} from \`${label}\`**`];
  }
  return [`**API quality: ${report.quality_index} · not comparable with \`${label}\`**`, `Not comparable with \`${label}\`: ${(b && b.reason) || 'no baseline'}.`];
}

function riskLine(risk) {
  if (!risk.assessed) return 'Change risk: ⚪ not assessed';
  if (risk.breaking) return `Change risk: 🔴 ${riskText(risk)}`;
  return `Change risk: 🟢 no breaking change${typeof risk.consumers === 'number' ? ` · ${plural(risk.consumers, 'known consumer')}` : ''}`;
}

function ratchetLine(report) {
  if (!report.no_regression) return null;
  const { max_drop: max, status } = report.no_regression;
  return status === 'not_comparable' ? `Ratchet (no_regression.max_drop ${max}): not enforced, no comparable baseline.` : `Ratchet (no_regression.max_drop ${max}): ${status === 'violated' ? 'violated' : 'respected'}.`;
}

/** Findings of the feedback grouped by step, one Fix line when the step's findings share the same hint. */
function renderFindings(feedback, more) {
  const out = [];
  const order = [...new Set(feedback.map((f) => f.step))];
  for (const id of order) {
    const items = feedback.filter((f) => f.step === id);
    const shared = items.every((f) => f.fix === items[0].fix);
    out.push(`**${ICON[items[0].status] || '⚪'} ${id}**`, '');
    for (const f of items) out.push(`- ${oneLine(f.finding)}${shared ? '' : `  \n  Fix: ${oneLine(f.fix)}`}`);
    if (more[id]) out.push(`- +${more[id]} more (see the step output)`);
    if (shared) out.push('', `Fix: ${oneLine(items[0].fix)}`);
    out.push('');
  }
  return out;
}

function renderMarkdown(cfg, report, steps, quality = {}) {
  const { passed, rating, score, blockers, feedback } = report;
  const { delta, label, more = {}, risk = { assessed: false } } = quality;
  const baseSteps = report.baseline && report.baseline.steps;
  const withBase = Boolean(delta);
  const vsCell = (s) => {
    if (!withBase || !QUALITY_STEPS.includes(s.step)) return '–';
    const b = baseSteps[s.step];
    if (typeof b !== 'number' || typeof s.score !== 'number') return '–';
    if (b === s.score) return '🟰 0';
    return s.score > b ? `⬆️ +${s.score - b}` : `⬇️ ${MINUS}${b - s.score}`;
  };
  const rows = steps.map((s) => `| ${ICON[s.status] || '⚪'} ${s.step} | ${s.status === 'not_available' ? 'n/a' : s.score} |${withBase ? ` ${vsCell(s)} |` : ''} ${cell(s.summary)} |`);

  const missingRequired = cfg.required_steps.filter((id) => steps.some((x) => x.step === id && x.status === 'not_available'));
  const accepted = report.steps.reduce((n, s) => n + (s.accepted_exceptions || 0), 0);
  const ratingParts = [
    `Rating **${rating}** (${score}/100${missingRequired.length ? ' on the steps that ran' : ''})`,
    ...(missingRequired.length ? [`required step${missingRequired.length > 1 ? 's' : ''} ${missingRequired.join(', ')} did not run`] : []),
    `required: ${cfg.pass_rating} or better, no blocker`,
    ...(accepted ? [`${plural(accepted, 'accepted lint exception')}`] : []),
    ...(report.commit ? [`commit \`${String(report.commit).slice(0, 7)}\``] : []),
    ...(report.run_url ? [`[CI run](${report.run_url})`] : []),
  ];
  const header = qualityHeader(report, label, delta);
  const lines = [
    REPORT_MARKER,
    `## ${passed ? '✅' : '❌'} API quality gate: ${passed ? 'PASSED' : 'FAILED'}`,
    '',
    `${header[0]}  `,
    ...header.slice(1).map((l) => `${l}  `),
    `${riskLine(risk)}`,
    '',
    ratingParts.join(' · '),
    '',
    ...(ratchetLine(report) ? [ratchetLine(report), ''] : []),
    `| Step | Score |${withBase ? ` vs ${label} |` : ''} Summary |`,
    `|------|------:|${withBase ? ':-----:|' : ''}---------|`,
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
    lines.push(`<details><summary>${passed ? 'Suggestions, non-blocking' : 'What to fix'} (${feedback.length})</summary>`, '', ...renderFindings(feedback, more), '</details>', '');
  }
  const acceptedRows = steps.flatMap((s) => (Array.isArray(s.accepted) ? s.accepted : []).map((a) => ({ step: s.step, ...a })));
  if (acceptedRows.length) {
    lines.push(
      `<details><summary>Accepted exceptions (${acceptedRows.length}, human decisions)</summary>`,
      '',
      'These findings are removed from the score and the blockers because a person accepted them in the gate config. They are still real findings.',
      '',
      '| Step | Finding | Path | Reason |',
      '|------|---------|------|--------|',
      ...acceptedRows.map((a) => `| ${a.step} | ${cell(`${a.severity}: ${a.issue ?? ''}`)} | \`${cell(a.path)}\` | ${cell(a.reason)} |`),
      '',
      '</details>',
      '',
    );
  }
  // Raw dump only for details the list above cannot show (neither a result nor a hint).
  for (const s of steps.filter((x) => x.status === 'warn' || x.status === 'fail')) {
    const bare = (s.details || []).filter((d) => d && !d.result && !d.hint);
    if (bare.length) lines.push(`<details><summary>${ICON[s.status]} ${s.step}: raw details (${bare.length})</summary>`, '', '```json', JSON.stringify(bare, null, 2).slice(0, 3000), '```', '', '</details>', '');
  }
  lines.push(
    '<details><summary>Reproduce locally</summary>',
    '',
    ...steps.flatMap((s) => [`- ${ICON[s.status] || '⚪'} **${s.step}**: \`${RUNNER_COMMAND} run ${s.step}\`${s.command ? `  \n  underlying: \`${oneLine(s.command)}\`` : ''}`]),
    '',
    '</details>',
    '',
  );
  const weights = cfg.steps.filter((id) => (cfg.weights[id] || 0) > 0).map((id) => `${id} ${cfg.weights[id]}`).join(', ');
  const b = report.baseline;
  const foot = [
    `healthcare-api-quality-gate ${GATE_VERSION}`,
    ...(report.cli_version ? [`Postman CLI ${report.cli_version}`] : []),
    ...(report.spec ? [`spec \`${report.spec.path}\` (${report.spec.type})`] : []),
    ...(report.collection ? [`collection \`${report.collection.path}\``] : []),
    ...(b && b.source !== 'none' && b.sha ? [`baseline: \`${label}\` @ \`${String(b.sha).slice(0, 7)}\` (${b.source === 'artifact' ? 'gate report of that commit' : 'steps re-run on that commit'})`] : []),
    ...(weights ? [`score weights: ${weights}`] : []),
  ];
  lines.push(`<sub>${foot.join(' · ')}</sub>`, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = { aggregate, ratingFor, renderMarkdown };

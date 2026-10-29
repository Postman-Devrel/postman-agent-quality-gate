'use strict';
// API quality index, delta against the base commit, change risk and the optional ratchet.
// Pure functions: the aggregation and the baseline resolver both use them, the tests need no CLI.
const crypto = require('crypto');

// The steps that describe the API at one commit. skills-check is repo hygiene, impact is about the change.
const QUALITY_STEPS = ['contract-lint', 'contract-tests', 'coverage', 'ai-readiness'];
// |points| at or below this is "stable": noise, not a trend.
const STABLE_POINTS = 2;

const usable = (cfg, scores, id) => cfg.steps.includes(id) && (cfg.weights[id] || 0) > 0 && typeof scores[id] === 'number';

/**
 * Weighted score (same weights as the gate, re-normalized) over `ids` (default: the quality steps).
 * `scores` maps step id -> score, or null/undefined when the step is not_available (left out).
 * Returns null when no step can be counted.
 */
function indexFromScores(cfg, scores, ids = QUALITY_STEPS) {
  const counted = ids.filter((id) => usable(cfg, scores || {}, id));
  const total = counted.reduce((sum, id) => sum + cfg.weights[id], 0);
  return total ? Math.round(counted.reduce((sum, id) => sum + scores[id] * cfg.weights[id], 0) / total) : null;
}

/** Scores of the quality steps found in a list of step results ({ step, status, score }). */
function scoresOf(steps) {
  const out = {};
  for (const id of QUALITY_STEPS) {
    const s = (steps || []).find((x) => x.step === id);
    if (s) out[id] = s.status !== 'not_available' && typeof s.score === 'number' ? s.score : null;
  }
  return out;
}

/**
 * Head against base, on the steps that have a score on both sides (an index over different steps would not be
 * comparable). null when there is no baseline or no common step: never a made-up number.
 */
function computeDelta(cfg, headScores, baseline) {
  if (!baseline || !baseline.steps) return null;
  const common = QUALITY_STEPS.filter((id) => usable(cfg, headScores, id) && usable(cfg, baseline.steps, id));
  if (!common.length) return null;
  const head = indexFromScores(cfg, headScores, common);
  const base = indexFromScores(cfg, baseline.steps, common);
  const points = head - base;
  return {
    points,
    percent: base > 0 ? Math.round((points / base) * 100) : null,
    stable: Math.abs(points) <= STABLE_POINTS,
    head,
    base,
    steps: common,
  };
}

/** Change risk, from the impact step: not a delta, a property of the change. */
function changeRisk(steps) {
  const s = (steps || []).find((x) => x.step === 'impact');
  if (!s || s.status === 'not_available') return { assessed: false, breaking: null, consumers: null };
  const details = s.details || [];
  const consumers = details.filter((d) => d && d.check === 'consumer').length;
  const breaking = details.some((d) => d && (d.breaking === true || d.check === 'breaking-change'));
  return { assessed: true, breaking, consumers };
}

/** Hash of the settings that feed the index: two reports are comparable only if it is the same. */
function configHash(cfg) {
  const pick = { steps: cfg.steps, weights: cfg.weights, ai_readiness: cfg.ai_readiness, 'contract-lint': cfg['contract-lint'] };
  return crypto.createHash('sha256').update(JSON.stringify(pick)).digest('hex').slice(0, 16);
}

/** Ratchet (no_regression.max_drop): a blocker message when the drop is larger than allowed, else null. */
function ratchet(cfg, delta, label) {
  if (!cfg.no_regression) return { max_drop: null, status: 'off', blocker: null };
  const max = cfg.no_regression.max_drop;
  if (!delta) return { max_drop: max, status: 'not_comparable', blocker: null };
  if (-delta.points > max) {
    return { max_drop: max, status: 'violated', blocker: `API quality dropped by ${-delta.points} point${-delta.points > 1 ? 's' : ''} against ${label} (${delta.base} → ${delta.head}); the allowed drop is ${max} (no_regression.max_drop)` };
  }
  return { max_drop: max, status: 'ok', blocker: null };
}

const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}`;

/** "86 → 72 vs main (−14 pts, −16 %)" or "72, not comparable with main". */
function deltaText(index, delta, label) {
  if (index === null || index === undefined) return 'API quality not available';
  if (!delta) return `API quality ${index}, not comparable with ${label}`;
  const parts = [`${signed(delta.points)} pts`];
  if (delta.percent !== null) parts.push(`${signed(delta.percent)} %`);
  if (delta.stable) parts.push('stable');
  return `API quality ${delta.base} → ${delta.head} vs ${label} (${parts.join(', ')})`;
}

function riskText(risk) {
  if (!risk.assessed) return 'change risk not assessed';
  if (!risk.breaking) return 'no breaking change';
  return risk.consumers ? `breaking change for ${risk.consumers} consumer${risk.consumers > 1 ? 's' : ''}` : 'breaking change, no known consumer';
}

module.exports = { QUALITY_STEPS, STABLE_POINTS, indexFromScores, scoresOf, computeDelta, changeRisk, configHash, ratchet, deltaText, riskText };

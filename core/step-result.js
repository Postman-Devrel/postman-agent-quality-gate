'use strict';
// Helpers to build the step result contract: { step, status, score, summary, details, command }.
// status: pass | warn | fail | not_available. score: 0-100, null when not_available.
const { RUNNER_COMMAND, DEGRADED_SCORE_CAP } = require('./constants');

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const result = (step, status, score, summary, details = [], command = '') => ({ step, status, score, summary, details, command });
const notAvailable = (step, reason, command = '') => result(step, 'not_available', null, `NOT_AVAILABLE: ${reason}`, [], command);

/**
 * A missing capability is a gap, never a pass. A step that ran with a weakened check sets `degraded: "<reason>"`;
 * its status is then at best `warn` (a fail stays a fail) and its score is capped at DEGRADED_SCORE_CAP.
 * Idempotent; applied by the runner and again by the aggregation (results may come from elsewhere).
 */
function applyDegraded(res) {
  if (!res || !res.degraded || res.status === 'not_available') return res;
  if (res.status === 'pass') res.status = 'warn';
  if (typeof res.score === 'number') res.score = Math.min(res.score, DEGRADED_SCORE_CAP);
  return res;
}

/** The command that re-runs a step, cited in hints. */
const rerun = (step) => `${RUNNER_COMMAND} run ${step}`;

module.exports = { plural, result, notAvailable, rerun, applyDegraded };

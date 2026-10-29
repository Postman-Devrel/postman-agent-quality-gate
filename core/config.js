'use strict';
// Config loader: quality-gate.yml (optional), built-in defaults, validation with clear errors.
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { STEP_IDS, LETTERS, DEFAULT_CONFIG_FILE } = require('./constants');

const EXCEPTION_KEYS = ['path', 'issue', 'reason'];
const BLOCKER_RULES = ['on_fail', 'on_warn', 'on_breaking'];

const DEFAULTS = Object.freeze({
  spec: null,
  collection: null,
  impact: { api: null },
  ai_readiness: { pass_min: 80, warn_min: 60 },
  steps: STEP_IDS.slice(),
  weights: { 'skills-check': 10, 'contract-lint': 25, 'contract-tests': 20, coverage: 5, 'ai-readiness': 20, impact: 20 },
  rating: { A: 90, B: 80, C: 70, D: 50 },
  pass_rating: 'B',
  blockers: { 'contract-lint': 'on_fail', 'contract-tests': 'on_fail', impact: 'on_breaking' },
  required_steps: ['contract-lint', 'contract-tests'],
  'contract-lint': { exceptions: [] },
  no_regression: null, // { max_drop: <points> }: off by default
});

class ConfigError extends Error {
  constructor(errors) {
    super(`Invalid configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validates a raw config object and returns the merged config. Throws ConfigError with every problem found. */
function validateConfig(raw, source = DEFAULT_CONFIG_FILE) {
  const errors = [];
  const err = (m) => errors.push(`${source}: ${m}`);
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  raw = raw ?? {};
  if (!isObj(raw)) throw new ConfigError([`${source}: the file must contain a mapping at its root`]);

  const known = Object.keys(DEFAULTS);
  for (const k of Object.keys(raw)) if (!known.includes(k)) err(`unknown key "${k}" (known keys: ${known.join(', ')})`);

  for (const k of ['spec', 'collection']) {
    if (raw[k] === undefined || raw[k] === null) continue;
    if (typeof raw[k] !== 'string' || !raw[k].trim()) err(`"${k}" must be a non-empty path (relative to the project root)`);
    else cfg[k] = raw[k];
  }

  if (raw.impact !== undefined && raw.impact !== null) {
    if (!isObj(raw.impact)) err('"impact" must be a mapping (impact.api)');
    else {
      for (const k of Object.keys(raw.impact)) if (k !== 'api') err(`unknown key "impact.${k}"`);
      if (raw.impact.api !== undefined && raw.impact.api !== null) {
        if (typeof raw.impact.api !== 'string' || !raw.impact.api.trim()) err('"impact.api" must be a non-empty string (the API name in the Context Graph)');
        else cfg.impact.api = raw.impact.api;
      }
    }
  }

  if (raw.ai_readiness !== undefined && raw.ai_readiness !== null) {
    if (!isObj(raw.ai_readiness)) err('"ai_readiness" must be a mapping (pass_min, warn_min)');
    else {
      for (const [k, v] of Object.entries(raw.ai_readiness)) {
        if (!['pass_min', 'warn_min'].includes(k)) err(`unknown key "ai_readiness.${k}" (use pass_min, warn_min)`);
        else if (typeof v !== 'number' || v < 0 || v > 100) err(`"ai_readiness.${k}" must be a number between 0 and 100`);
        else cfg.ai_readiness[k] = v;
      }
      if (cfg.ai_readiness.warn_min > cfg.ai_readiness.pass_min) err('"ai_readiness.warn_min" must not exceed "ai_readiness.pass_min"');
    }
  }

  if (raw.steps !== undefined && raw.steps !== null) {
    if (!Array.isArray(raw.steps) || !raw.steps.length) err(`"steps" must be a non-empty list of step ids (${STEP_IDS.join(', ')})`);
    else {
      const bad = raw.steps.filter((s) => !STEP_IDS.includes(s));
      if (bad.length) err(`unknown step(s) in "steps": ${bad.join(', ')} (known: ${STEP_IDS.join(', ')})`);
      else cfg.steps = [...new Set(raw.steps)];
    }
  }

  if (raw.weights !== undefined && raw.weights !== null) {
    if (!isObj(raw.weights)) err('"weights" must be a mapping step -> number');
    else {
      for (const [k, v] of Object.entries(raw.weights)) {
        if (!STEP_IDS.includes(k)) err(`"weights.${k}": unknown step`);
        else if (typeof v !== 'number' || v < 0) err(`"weights.${k}" must be a number >= 0`);
        else cfg.weights[k] = v;
      }
    }
  }

  if (raw.rating !== undefined && raw.rating !== null) {
    if (!isObj(raw.rating)) err('"rating" must be a mapping letter -> minimum score');
    else {
      for (const [k, v] of Object.entries(raw.rating)) {
        if (!LETTERS.includes(k) || k === 'E') err(`"rating.${k}": use the letters A, B, C, D (anything lower is E)`);
        else if (typeof v !== 'number' || v < 0 || v > 100) err(`"rating.${k}" must be a number between 0 and 100`);
        else cfg.rating[k] = v;
      }
    }
  }
  const thresholds = ['A', 'B', 'C', 'D'].map((l) => cfg.rating[l]);
  if (thresholds.some((t, i) => i > 0 && t > thresholds[i - 1])) err('"rating" thresholds must decrease from A to D');

  if (raw.pass_rating !== undefined && raw.pass_rating !== null) {
    if (!LETTERS.includes(raw.pass_rating)) err(`"pass_rating" must be one of ${LETTERS.join(', ')}`);
    else cfg.pass_rating = raw.pass_rating;
  }

  if (raw.blockers !== undefined && raw.blockers !== null) {
    if (!isObj(raw.blockers)) err('"blockers" must be a mapping step -> rule');
    else {
      cfg.blockers = {};
      for (const [k, v] of Object.entries(raw.blockers)) {
        if (!STEP_IDS.includes(k)) err(`"blockers.${k}": unknown step`);
        else if (!BLOCKER_RULES.includes(v)) err(`"blockers.${k}" must be one of ${BLOCKER_RULES.join(', ')}`);
        else cfg.blockers[k] = v;
      }
    }
  }

  if (raw.required_steps !== undefined && raw.required_steps !== null) {
    if (!Array.isArray(raw.required_steps)) err('"required_steps" must be a list of step ids');
    else {
      const bad = raw.required_steps.filter((s) => !STEP_IDS.includes(s));
      if (bad.length) err(`unknown step(s) in "required_steps": ${bad.join(', ')}`);
      else cfg.required_steps = [...new Set(raw.required_steps)];
    }
  }

  if (raw['contract-lint'] !== undefined && raw['contract-lint'] !== null) {
    const cl = raw['contract-lint'];
    if (!isObj(cl)) err('"contract-lint" must be a mapping (contract-lint.exceptions)');
    else {
      for (const k of Object.keys(cl)) if (k !== 'exceptions') err(`unknown key "contract-lint.${k}" (use exceptions)`);
      if (cl.exceptions !== undefined && cl.exceptions !== null) {
        if (!Array.isArray(cl.exceptions)) err('"contract-lint.exceptions" must be a list of { path, issue, reason }');
        else {
          cl.exceptions.forEach((ex, i) => {
            const at = `contract-lint.exceptions[${i}]`;
            if (!isObj(ex)) return err(`"${at}" must be a mapping with path, issue and reason`);
            for (const k of Object.keys(ex)) if (!EXCEPTION_KEYS.includes(k)) err(`unknown key "${at}.${k}" (use ${EXCEPTION_KEYS.join(', ')})`);
            const bad = EXCEPTION_KEYS.filter((k) => typeof ex[k] !== 'string' || !ex[k].trim());
            for (const k of bad) err(`"${at}.${k}" is required and must be a non-empty string${k === 'reason' ? ' (an exception is a human decision: say why)' : ''}`);
            if (!bad.length && !Object.keys(ex).some((k) => !EXCEPTION_KEYS.includes(k))) {
              cfg['contract-lint'].exceptions.push({ path: ex.path.trim(), issue: ex.issue.trim(), reason: ex.reason.trim() });
            }
          });
        }
      }
    }
  }

  if (raw.no_regression !== undefined && raw.no_regression !== null) {
    const nr = raw.no_regression;
    if (!isObj(nr)) err('"no_regression" must be a mapping (no_regression.max_drop)');
    else {
      for (const k of Object.keys(nr)) if (k !== 'max_drop') err(`unknown key "no_regression.${k}" (use max_drop)`);
      if (typeof nr.max_drop !== 'number' || nr.max_drop < 0 || nr.max_drop > 100) err('"no_regression.max_drop" is required: a number of points between 0 and 100');
      else cfg.no_regression = { max_drop: nr.max_drop };
    }
  }

  // Cross checks: a step that is judged must be enabled.
  for (const s of cfg.required_steps) if (!cfg.steps.includes(s)) err(`"required_steps" lists "${s}" but it is not in "steps"`);
  for (const s of Object.keys(cfg.blockers)) if (!cfg.steps.includes(s)) err(`"blockers" lists "${s}" but it is not in "steps"`);

  if (errors.length) throw new ConfigError(errors);
  return cfg;
}

/**
 * Loads the config. `file` is the --config value (resolved against cwd); without it, quality-gate.yml at the
 * project root is used when it exists. An explicit file that is missing is an error.
 */
function loadConfig(cwd, file) {
  const explicit = Boolean(file);
  const abs = path.resolve(cwd, file || DEFAULT_CONFIG_FILE);
  const rel = path.relative(cwd, abs) || DEFAULT_CONFIG_FILE;
  if (!fs.existsSync(abs)) {
    if (explicit) throw new ConfigError([`config file not found: ${file}`]);
    return { config: validateConfig({}, rel), file: null };
  }
  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new ConfigError([`${rel}: not valid YAML (${e.message.split('\n')[0]})`]);
  }
  return { config: validateConfig(raw, rel), file: rel };
}

module.exports = { DEFAULTS, ConfigError, validateConfig, loadConfig, BLOCKER_RULES };

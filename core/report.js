'use strict';
const fs = require('fs');
const path = require('path');
const { STEP_IDS, REPORT_MARKER, GATE_VERSION } = require('./constants');

function readResults(resultsDir, ids) {
  const out = {};
  for (const id of ids) {
    const file = path.join(resultsDir, `${id}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      out[id] = { ...JSON.parse(fs.readFileSync(file, 'utf8')), step: id };
    } catch (e) {
      out[id] = { step: id, status: 'not_available', score: null, summary: `NOT_AVAILABLE: unreadable result file (${e.message})`, details: [], command: '' };
    }
  }
  return out;
}

function writeResult(resultsDir, res) {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${res.step}.json`), JSON.stringify(res, null, 2));
}

function writeReport(resultsDir, report, markdown) {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'report.md'), markdown);
  fs.writeFileSync(path.join(resultsDir, 'report.json'), JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
}

function clearResults(resultsDir, ids = STEP_IDS) {
  for (const f of [...ids.map((i) => `${i}.json`), 'baseline.json', 'report.json', 'report.md']) fs.rmSync(path.join(resultsDir, f), { force: true });
}

/** URL of the CI run, from the GitHub Actions environment; null outside CI. */
function runUrl(env = process.env) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = env || {};
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : null;
}

/**
 * Commit the report is about. On pull_request events GITHUB_SHA (and git HEAD of the checkout) is GitHub's
 * merge commit, not the commit the author pushed: prefer GATE_HEAD_SHA, then the PR head SHA of the event
 * payload (GITHUB_EVENT_PATH), then `fallback` (git HEAD).
 */
function headCommit(env = process.env, fallback = null) {
  const sha = (v) => (typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v.trim()) ? v.trim() : null);
  const { GATE_HEAD_SHA: given, GITHUB_EVENT_PATH: file } = env || {};
  if (sha(given)) return sha(given);
  if (file) {
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (sha(payload && payload.pull_request && payload.pull_request.head && payload.pull_request.head.sha)) return sha(payload.pull_request.head.sha);
    } catch { /* no readable event payload: fall back */ }
  }
  return fallback || null;
}

/** Report of a run the workflow skipped: nothing the gate judges changed against the base. */
function skippedReport(base) {
  const name = String(base || 'the base branch').replace(/^origin\//, '');
  const markdown = [
    REPORT_MARKER,
    '## ⏭️ API quality gate: SKIPPED',
    '',
    `This branch no longer changes the API contract against ${name}; the gate did not run. If the change was reverted, the original change is no longer in this PR.`,
    '',
    `<sub>healthcare-api-quality-gate ${GATE_VERSION}</sub>`,
    '',
  ].join('\n');
  return { report: { skipped: true, reason: 'no relevant change', base: name }, markdown };
}

function writeBaseline(resultsDir, baseline) {
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'baseline.json'), JSON.stringify(baseline, null, 2));
}

function readBaseline(resultsDir) {
  try { return JSON.parse(fs.readFileSync(path.join(resultsDir, 'baseline.json'), 'utf8')); } catch { return null; }
}

module.exports = { runUrl, headCommit, skippedReport, writeBaseline, readBaseline, readResults, writeResult, writeReport, clearResults };

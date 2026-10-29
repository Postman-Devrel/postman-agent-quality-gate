'use strict';
// Baseline of the quality index: where the base commit stood. Three sources, in this order:
//   artifact  the gate-report of the latest successful gate run on that exact base commit (CI), if it is
//             comparable (same gate version, same index settings, same commit)
//   rerun     the four quality steps run on a git worktree of the base commit
//   none      neither worked: the delta is "not comparable", never a made-up number
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildContext, runStep, cliVersion } = require('./runner');
const { QUALITY_STEPS, indexFromScores, scoresOf, configHash } = require('./quality');
const { GATE_VERSION } = require('./constants');
const { resolveBaseRef } = require('../steps/impact');

const none = (ref, sha, reason) => ({ ref, sha, source: 'none', gate_version: null, quality_index: null, steps: null, reason });

/** The base ref and the merge-base commit of HEAD with it. */
function baseCommit(ctx) {
  const git = (...a) => ctx.exec('git', a, { cwd: ctx.cwd, env: ctx.env });
  if (git('rev-parse', '--verify', '-q', 'HEAD').status !== 0) return { ref: null, sha: null, reason: 'not a git repository with a commit' };
  const resolved = resolveBaseRef(ctx);
  const ref = ctx.env.GATE_BASE_NAME || resolved; // a display name (main) when the CI resolves the base by SHA
  if (resolved === 'HEAD') return { ref, sha: null, reason: 'no base branch found (origin/HEAD, origin/main, origin/master); set GATE_BASE_REF' };
  const mb = git('merge-base', resolved, 'HEAD');
  const sha = mb.status === 0 && mb.stdout.trim() ? mb.stdout.trim() : null;
  return sha ? { ref, sha } : { ref, sha: null, reason: `no merge base between ${resolved} and HEAD` };
}

/** A previous report.json as a baseline, or { reason } when it cannot be compared. */
function fromReport(ctx, base, file) {
  let report;
  try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { reason: 'no gate report for the base commit' }; }
  if (!report || report.skipped) return { reason: 'the gate run of the base commit was skipped (no report to compare)' };
  if (report.gate_version !== GATE_VERSION) return { reason: `the base report comes from gate ${report.gate_version || 'unknown'}, this is ${GATE_VERSION}` };
  if (report.config_hash !== configHash(ctx.config)) return { reason: 'the base report was computed with different gate settings' };
  if (report.commit && report.commit !== base.sha) return { reason: `the base report is for ${String(report.commit).slice(0, 7)}, not ${base.sha.slice(0, 7)}` };
  const steps = scoresOf(report.steps);
  const index = indexFromScores(ctx.config, steps);
  if (index === null) return { reason: 'the base report has no scored quality step' };
  return { baseline: { ref: base.ref, sha: base.sha, source: 'artifact', gate_version: report.gate_version, quality_index: index, steps, ...(typeof report.score === 'number' ? { score: report.score } : {}) } };
}

/** Runs the quality steps on a worktree of the base commit. Never throws. */
function rerun(ctx, base) {
  const git = (cwd, ...a) => ctx.exec('git', a, { cwd, env: ctx.env });
  const top = git(ctx.cwd, 'rev-parse', '--show-toplevel').stdout.trim();
  if (!top) return { reason: 'cannot locate the git repository' };
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pqg-base-'));
  const wt = path.join(parent, 'wt');
  try {
    const add = git(top, 'worktree', 'add', '--detach', wt, base.sha);
    if (add.status !== 0) return { reason: `cannot check out the base commit: ${add.stderr.trim().split('\n')[0]}` };
    const rel = path.relative(fs.realpathSync(top), fs.realpathSync(ctx.cwd));
    const cwd = path.join(wt, rel);
    if (!fs.existsSync(cwd)) return { reason: `${rel || '.'} does not exist on the base commit` };
    const bctx = buildContext({ cwd, configFile: ctx.configFile, resultsDir: path.join(parent, 'results'), overrides: { env: ctx.env, exec: ctx.exec, log: ctx.log } });
    bctx.config = ctx.config; // same settings on both sides, or the numbers do not compare
    const version = cliVersion(bctx);
    const results = ctx.config.steps.filter((id) => QUALITY_STEPS.includes(id)).map((id) => runStep(bctx, id, { write: false, version }));
    const steps = scoresOf(results);
    const index = indexFromScores(ctx.config, steps);
    if (index === null) return { reason: 'no quality step could run on the base commit' };
    return { baseline: { ref: base.ref, sha: base.sha, source: 'rerun', gate_version: GATE_VERSION, quality_index: index, steps } };
  } catch (e) {
    return { reason: `rerun on the base commit failed: ${e.message}` };
  } finally {
    git(top, 'worktree', 'remove', '--force', wt);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

/** Resolves the baseline. `reportFile`: report.json of the base commit downloaded by the CI, optional. */
function resolveBaseline(ctx, { reportFile } = {}) {
  const base = baseCommit(ctx);
  if (!base.sha) return none(base.ref, null, base.reason);
  let why = null;
  if (reportFile) {
    const r = fromReport(ctx, base, reportFile);
    if (r.baseline) return r.baseline;
    why = r.reason;
    ctx.log(`baseline: ${why}; running the quality steps on ${base.sha.slice(0, 7)}`);
  }
  const r = rerun(ctx, base);
  if (r.baseline) return r.baseline;
  return none(base.ref, base.sha, why ? `${why}; ${r.reason}` : r.reason);
}

module.exports = { resolveBaseline, baseCommit, fromReport, rerun };

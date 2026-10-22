'use strict';
// Runs steps. A step never throws: a crash, a missing tool or an unsupported spec type becomes not_available.
// Only the aggregation decides pass or fail.
const path = require('path');
const { loadConfig } = require('./config');
const { resolveInputs } = require('./resources');
const { exec: realExec } = require('./exec');
const { notAvailable, applyDegraded } = require('./step-result');
const { writeResult } = require('./report');
const { POSTMAN_CLI_VERSION } = require('./constants');
const { byId } = require('../steps');

/** Builds the context shared by the steps. `overrides` lets tests inject exec, env, cwd. */
function buildContext({ cwd, configFile, resultsDir, overrides = {} }) {
  const { config } = loadConfig(cwd, configFile);
  const inputs = resolveInputs(cwd, config);
  const exec = overrides.exec || realExec;
  const env = overrides.env || process.env;
  return {
    cwd,
    configFile,
    config,
    spec: inputs.spec,
    collection: inputs.collection,
    resultsDir: path.resolve(cwd, resultsDir),
    env,
    exec,
    log: overrides.log || ((m) => process.stderr.write(`[gate] ${m}\n`)),
  };
}

/** `postman --version` -> "1.76.0", or null when the CLI is missing. */
function cliVersion(ctx) {
  const r = ctx.exec('postman', ['--version'], { cwd: ctx.cwd, env: ctx.env, timeout: 30000 });
  if (r.error || r.status !== 0) return null;
  const m = r.stdout.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

/** Why a step cannot run in this context, or null when it can. */
function blockerFor(step, ctx, version) {
  if (step.needsSpec !== false) {
    if (!ctx.spec) return 'no spec found: declare one in .postman/resources.yaml (cloudResources.specs) or set "spec" in the config file';
    if (!step.supports.includes('*') && !step.supports.includes(ctx.spec.type)) {
      return `spec type "${ctx.spec.type}" is not supported by ${step.id} (supports: ${step.supports.join(', ')})`;
    }
  }
  if (step.needsCollection && !ctx.collection) return 'no collection found: declare one in .postman/resources.yaml (cloudResources.collections) or set "collection" in the config file';
  if (step.needsCli && !version) return `postman CLI not installed (expected ${POSTMAN_CLI_VERSION})`;
  return null;
}

/** Runs one step safely. Returns the result (also written to resultsDir unless write === false). */
function runStep(ctx, id, { write = true, version } = {}) {
  const step = byId[id];
  let res;
  try {
    const why = blockerFor(step, ctx, version);
    res = why ? notAvailable(id, why) : step.run(ctx);
  } catch (e) {
    res = notAvailable(id, `step crashed: ${e && e.message ? e.message : e}`);
  }
  applyDegraded(res);
  if (version && step.needsCli) res.cli_version = version;
  if (write) writeResult(ctx.resultsDir, res);
  return res;
}

function runSteps(ctx, ids) {
  const version = cliVersion(ctx);
  if (version && version !== POSTMAN_CLI_VERSION) ctx.log(`Postman CLI ${version} found, the gate is pinned to ${POSTMAN_CLI_VERSION}`);
  return { version, results: ids.map((id) => runStep(ctx, id, { version })) };
}

module.exports = { buildContext, runStep, runSteps, cliVersion, blockerFor };

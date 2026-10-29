#!/usr/bin/env node
'use strict';
// healthcare-api-quality-gate run [step...] [--config f] [--results-dir d] [--no-exit-code]
// healthcare-api-quality-gate aggregate [--config f] [--results-dir d] [--no-exit-code]
// healthcare-api-quality-gate baseline [--report f] [--config f] [--results-dir d]   (quality index of the base commit)
// healthcare-api-quality-gate skipped [--base name] [--results-dir d]   (report of a run the workflow skipped)
// healthcare-api-quality-gate paths [--config f]   (CI plumbing: ERE of the files the gate judges)
const path = require('path');
const { ConfigError, loadConfig } = require('../core/config');
const { buildContext, runSteps, cliVersion } = require('../core/runner');
const { aggregate } = require('../core/aggregate');
const { relevantRegex } = require('../core/paths');
const { readResults, writeReport, clearResults, skippedReport, writeBaseline, readBaseline } = require('../core/report');
const { resolveBaseline } = require('../core/baseline');
const { STEP_IDS, DEFAULT_RESULTS_DIR, GATE_VERSION, POSTMAN_CLI_VERSION } = require('../core/constants');

const USAGE = `healthcare-api-quality-gate ${GATE_VERSION} (Postman CLI ${POSTMAN_CLI_VERSION})

Usage:
  healthcare-api-quality-gate run [step...] [--config f] [--results-dir d] [--no-exit-code]
  healthcare-api-quality-gate aggregate [--config f] [--results-dir d] [--no-exit-code]
  healthcare-api-quality-gate baseline [--report f] [--config f] [--results-dir d]

Steps: ${STEP_IDS.join(', ')}
"run" without a step runs every enabled step, then aggregates (exit 1 when the gate fails).
"run" also computes the quality baseline on the merge-base with the default branch (--no-baseline to skip it).
"baseline" writes <results-dir>/baseline.json (CI plumbing); "aggregate" reads it.
"run <step>" only writes <results-dir>/<step>.json and exits 0: the aggregation decides.
Exit codes: 0 passed, 1 gate failed, 2 configuration error.`;

function parseArgs(argv) {
  const o = { cmd: argv[0], steps: [], config: undefined, resultsDir: DEFAULT_RESULTS_DIR, noExit: false, report: undefined, base: undefined, noBaseline: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') o.config = argv[++i];
    else if (a === '--results-dir') o.resultsDir = argv[++i];
    else if (a === '--no-exit-code') o.noExit = true;
    else if (a === '--report') o.report = argv[++i];
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--no-baseline') o.noBaseline = true;
    else if (a.startsWith('--')) throw new ConfigError([`unknown option ${a}`]);
    else o.steps.push(a);
  }
  return o;
}

function main(argv) {
  if (!argv.length || ['-h', '--help', 'help'].includes(argv[0])) { console.log(USAGE); return 0; }
  if (!['run', 'aggregate', 'paths', 'baseline', 'skipped'].includes(argv[0])) throw new ConfigError([`unknown command "${argv[0]}"\n${USAGE}`]);
  const o = parseArgs(argv);
  const cwd = process.cwd();
  if (o.cmd === 'skipped') {
    const { report, markdown } = skippedReport(o.base);
    writeReport(path.resolve(cwd, o.resultsDir), report, markdown);
    console.log(markdown);
    return 0;
  }
  const ctx = buildContext({ cwd, configFile: o.config, resultsDir: o.resultsDir });
  if (o.cmd === 'paths') {
    console.log(relevantRegex(cwd, ctx));
    return 0;
  }
  if (o.cmd === 'baseline') {
    const b = resolveBaseline(ctx, { reportFile: o.report && path.resolve(cwd, o.report) });
    writeBaseline(ctx.resultsDir, b);
    console.log(`baseline: ${b.source}${b.quality_index === null ? ` (${b.reason})` : `, API quality ${b.quality_index} on ${b.ref}`}`);
    return 0;
  }
  const unknown = o.steps.filter((s) => !STEP_IDS.includes(s));
  if (unknown.length) throw new ConfigError([`unknown step(s): ${unknown.join(', ')} (known: ${STEP_IDS.join(', ')})`]);
  // A step disabled in the config is skipped, not an error: CI matrices list every step.
  const notEnabled = o.steps.filter((s) => !ctx.config.steps.includes(s));
  for (const s of notEnabled) console.log(`${s}: disabled in the config ("steps"), skipped`);
  o.steps = o.steps.filter((s) => ctx.config.steps.includes(s));
  if (notEnabled.length && !o.steps.length) return 0;

  let cli = null;
  if (o.cmd === 'run') {
    const all = o.steps.length === 0;
    const ids = all ? ctx.config.steps : o.steps;
    if (all) clearResults(ctx.resultsDir);
    const { version, results } = runSteps(ctx, ids);
    cli = version;
    for (const r of results) console.log(`${r.step}: ${r.status} (score=${r.score}) ${r.summary}`);
    if (!all) return 0;
    if (!o.noBaseline) writeBaseline(ctx.resultsDir, resolveBaseline(ctx));
  }

  const results = readResults(ctx.resultsDir, ctx.config.steps);
  cli = cli || Object.values(results).map((r) => r.cli_version).find(Boolean) || cliVersion(ctx);
  const head = ctx.exec('git', ['rev-parse', 'HEAD'], { cwd, env: ctx.env });
  const meta = { spec: ctx.spec, collection: ctx.collection, cli_version: cli, commit: head.status === 0 ? head.stdout.trim() : null, baseline: readBaseline(ctx.resultsDir) };
  const { report, markdown } = aggregate(ctx.config, results, meta);
  writeReport(ctx.resultsDir, report, markdown);
  console.log(markdown);
  return report.passed || o.noExit ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`Configuration error: ${e.message.replace(/^Invalid configuration:\n/, '')}`);
    process.exitCode = 2;
  } else {
    console.error(e);
    process.exitCode = 3;
  }
}

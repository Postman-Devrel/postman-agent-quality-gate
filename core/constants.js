'use strict';
// Single place for the values other modules and docs refer to.
const pkg = require('../package.json');

// How a project invokes the runner. Hints and docs cite this ONE constant.
// Distributed from Git first: `#v1` is the moving major tag of the repository.
// Override with PQG_RUNNER_COMMAND (e.g. for a fork or a local checkout).
const DEFAULT_RUNNER_COMMAND = 'npx github:Postman-Devrel/postman-agent-quality-gate#v1';
const RUNNER_COMMAND = process.env.PQG_RUNNER_COMMAND || DEFAULT_RUNNER_COMMAND;

module.exports = {
  GATE_VERSION: pkg.version,
  POSTMAN_CLI_VERSION: pkg.postmanCli, // pinned in package.json, nowhere else
  RUNNER_COMMAND,
  REPORT_MARKER: '<!-- postman-agent-quality-gate -->',
  SCHEMA_VERSION: 1,
  // A degraded step (its check was weakened, e.g. rules skipped) never scores above the warn level.
  DEGRADED_SCORE_CAP: 70,
  DEFAULT_RESULTS_DIR: 'gate-results',
  DEFAULT_CONFIG_FILE: 'quality-gate.yml',
  STEP_IDS: ['skills-check', 'contract-lint', 'contract-tests', 'coverage', 'ai-readiness', 'impact'],
  LETTERS: ['A', 'B', 'C', 'D', 'E'],
};

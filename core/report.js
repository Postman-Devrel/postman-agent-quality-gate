'use strict';
const fs = require('fs');
const path = require('path');
const { STEP_IDS } = require('./constants');

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
  for (const f of [...ids.map((i) => `${i}.json`), 'report.json', 'report.md']) fs.rmSync(path.join(resultsDir, f), { force: true });
}

module.exports = { readResults, writeResult, writeReport, clearResults };

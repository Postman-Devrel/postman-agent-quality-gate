'use strict';
// Step: coverage (coverage analogy). Does every operation of the spec have a request in the collection?
// Pure Node: reads the spec and the collection files, no CLI. Warn below 100%, score = percentage.
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { result, notAvailable, rerun } = require('../core/step-result');

const id = 'coverage';
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/** "/pets/{petId}" or "/pets/:petId" or "/pets/{{petId}}" -> "/pets/{}" ; drops query, host, trailing slash. */
function normalizePath(p) {
  let s = String(p || '').trim();
  s = s.replace(/^\{\{[^}]+\}\}/, ''); // leading {{baseUrl}}
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); // literal scheme://host
  s = s.replace(/[?#].*$/, '');
  s = s.replace(/\{\{[^}]+\}\}/g, '{}').replace(/\{[^}]+\}/g, '{}').replace(/(^|\/):[^/]+/g, '$1{}');
  s = s.replace(/\/+$/, '');
  return s.startsWith('/') ? s : '/' + s;
}

function operationsOf(doc) {
  const ops = [];
  for (const [p, item] of Object.entries((doc && doc.paths) || {})) {
    for (const m of METHODS) if (item && item[m]) ops.push({ method: m.toUpperCase(), path: p, key: `${m.toUpperCase()} ${normalizePath(p)}` });
  }
  return ops;
}

/** Base paths declared by the servers of the spec ("https://x/v1" -> "/v1"). */
function serverBasePaths(doc) {
  const out = new Set();
  for (const s of (doc && doc.servers) || []) {
    try {
      const p = new URL(String(s.url).replace(/\{[^}]+\}/g, 'x')).pathname.replace(/\/+$/, '');
      if (p) out.add(p);
    } catch { /* relative server url */
      const p = String(s.url).replace(/\/+$/, '');
      if (p.startsWith('/') && p !== '') out.add(p);
    }
  }
  return [...out];
}

function walkV3(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.resources') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkV3(full, out);
    else if (e.name.endsWith('.request.yaml')) {
      try {
        const doc = YAML.parse(fs.readFileSync(full, 'utf8'));
        if (doc && doc.method && doc.url) out.push({ method: String(doc.method).toUpperCase(), url: String(doc.url), name: e.name });
      } catch { /* unreadable request file: ignored */ }
    }
  }
}

function walkV2(items, out) {
  for (const it of items || []) {
    if (it.item) walkV2(it.item, out);
    else if (it.request) {
      const u = it.request.url;
      out.push({ method: String(it.request.method || 'GET').toUpperCase(), url: typeof u === 'string' ? u : (u && (u.raw || '/' + (u.path || []).join('/'))) || '', name: it.name });
    }
  }
}

/** Requests of a collection: a v3 folder (YAML files) or a v2.1 JSON file. */
function requestsOf(collectionAbs) {
  const out = [];
  const st = fs.statSync(collectionAbs);
  if (st.isDirectory()) walkV3(collectionAbs, out);
  else walkV2(JSON.parse(fs.readFileSync(collectionAbs, 'utf8')).item, out);
  return out;
}

/** Pure: operations + requests -> { total, covered, percent, missing[] }. */
function computeCoverage(ops, requests, basePaths = []) {
  const have = new Set();
  for (const r of requests) {
    const p = normalizePath(r.url);
    have.add(`${r.method} ${p}`);
    for (const b of basePaths) if (p.startsWith(b + '/')) have.add(`${r.method} ${p.slice(b.length)}`);
  }
  const missing = ops.filter((o) => !have.has(o.key));
  const total = ops.length;
  const covered = total - missing.length;
  return { total, covered, percent: total ? Math.floor((100 * covered) / total) : 100, missing };
}

function evaluate(cov, { collectionPath, command }) {
  const details = [{ check: 'coverage', result: `${cov.covered}/${cov.total} spec operations have a request in the collection (${cov.percent}%)` }];
  for (const m of cov.missing) {
    details.push({
      check: 'uncovered',
      result: `${m.method} ${m.path}`,
      hint: `Add a request for '${m.method} ${m.path}' to the collection ${collectionPath} with pm.test assertions (postman collection request add), then run \`${rerun(id)}\`.`,
    });
  }
  const summary = `${cov.covered}/${cov.total} operations covered (${cov.percent}%)`;
  return result(id, cov.percent < 100 ? 'warn' : 'pass', cov.percent, summary, details, command);
}

module.exports = {
  id,
  supports: ['openapi-3'],
  needsSpec: true,
  needsCollection: true,
  needsCli: false,
  normalizePath,
  operationsOf,
  requestsOf,
  computeCoverage,
  evaluate,
  run(ctx) {
    const command = 'compare spec operations with collection requests';
    let doc;
    try {
      doc = YAML.parse(fs.readFileSync(ctx.spec.abs, 'utf8'));
    } catch (e) {
      return notAvailable(id, `cannot read ${ctx.spec.path}: ${e.message.split('\n')[0]}`, command);
    }
    const cov = computeCoverage(operationsOf(doc), requestsOf(ctx.collection.abs), serverBasePaths(doc));
    return evaluate(cov, { collectionPath: ctx.collection.path, command });
  },
};

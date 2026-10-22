'use strict';
// OpenAPI adapter: lists the breaking changes between two versions of a spec.
// Takes the CONTENT of both versions (parsed documents), so no git history is needed here.
//
// A change is breaking for an existing consumer when it removes or renames something, or makes a request
// stricter. Additions (a new path, a new optional field, a new schema with its own required fields) are not.
// Port of the former gate/lib/contract-diff.py. Hints never name a project path.
const YAML = require('yaml');

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Follows a local $ref (up to 3 hops). Always returns an object. */
function resolve(spec, node) {
  for (let i = 0; i < 3; i++) {
    if (isObj(node) && typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
      let cur = spec;
      for (const part of node.$ref.slice(2).split('/')) cur = (isObj(cur) ? cur[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined) ?? {};
      node = cur;
    } else break;
  }
  return isObj(node) ? node : {};
}

const schemaOf = (spec, content) => resolve(spec, ((content || {})['application/json'] || {}).schema || {});

function props(spec, schema) {
  schema = resolve(spec, schema);
  const out = { ...(schema.properties || {}) };
  for (const part of schema.allOf || []) Object.assign(out, props(spec, part));
  return out;
}

function required(spec, schema) {
  schema = resolve(spec, schema);
  const req = new Set(schema.required || []);
  for (const part of schema.allOf || []) for (const r of required(spec, part)) req.add(r);
  return req;
}

function compareSchema(specB, specH, sb, sh, where, request, out, depth = 0) {
  sb = resolve(specB, sb);
  sh = resolve(specH, sh);
  if (depth > 4 || !Object.keys(sb).length) return;
  const pb = props(specB, sb);
  const ph = props(specH, sh);
  for (const [name, pschema] of Object.entries(pb)) {
    if (!(name in ph)) {
      out.push({ change: `${where}: property '${name}' was removed or renamed`, hint: `Keep '${name}' in ${where} (add the new name next to it) so existing consumers keep working.` });
      continue;
    }
    const tb = resolve(specB, pschema).type;
    const th = resolve(specH, ph[name]).type;
    if (tb && th && JSON.stringify(tb) !== JSON.stringify(th)) {
      out.push({ change: `${where}: property '${name}' changed type ${tb} -> ${th}`, hint: `Do not change the type of '${name}'; add a new field instead.` });
    }
    compareSchema(specB, specH, pschema, ph[name], `${where}.${name}`, request, out, depth + 1);
  }
  if (request) {
    const reqB = required(specB, sb);
    const reqH = required(specH, sh);
    for (const name of reqH) {
      if (reqB.has(name)) continue;
      if (name in pb) out.push({ change: `${where}: request field '${name}' became required`, hint: `Keep '${name}' optional: existing callers do not send it.` });
      else if (name in ph) out.push({ change: `${where}: new request field '${name}' is required`, hint: `Make '${name}' optional, existing callers do not send it.` });
    }
  }
}

/** @returns {{change:string, hint:string}[]} */
function diff(base, head) {
  const out = [];
  const pb = (base && base.paths) || {};
  const ph = (head && head.paths) || {};
  for (const [p, item] of Object.entries(pb)) {
    if (!(p in ph)) {
      out.push({ change: `path ${p} was removed or renamed`, hint: `Keep ${p} (add the new path next to it) or version the API.` });
      continue;
    }
    for (const method of METHODS) {
      if (!item || !item[method]) continue;
      const opB = item[method];
      const opH = ph[p][method];
      const label = `${method.toUpperCase()} ${p}`;
      if (!opH) {
        out.push({ change: `${label} was removed`, hint: `Keep ${label}, or version the API.` });
        continue;
      }
      for (const [code, resp] of Object.entries(opB.responses || {})) {
        if (!(code in (opH.responses || {}))) {
          out.push({ change: `${label}: response ${code} was removed`, hint: `Keep the ${code} response of ${label}.` });
          continue;
        }
        const rb = schemaOf(base, resolve(base, resp).content);
        const rh = schemaOf(head, resolve(head, opH.responses[code]).content);
        compareSchema(base, head, rb, rh, `${label} response ${code}`, false, out);
      }
      const rqB = resolve(base, opB.requestBody || {});
      const rqH = resolve(head, opH.requestBody || {});
      if (Object.keys(rqB).length) {
        if (rqH.required && !rqB.required) out.push({ change: `${label}: the request body became required`, hint: `Keep the body of ${label} optional.` });
        compareSchema(base, head, schemaOf(base, rqB.content), schemaOf(head, rqH.content), `${label} request`, true, out);
      }
      const namesB = new Set([...(item.parameters || []), ...(opB.parameters || [])].map((x) => resolve(base, x).name));
      for (const prm of [...(ph[p].parameters || []), ...(opH.parameters || [])]) {
        const r = resolve(head, prm);
        if (r.required && !namesB.has(r.name)) out.push({ change: `${label}: new required parameter '${r.name}'`, hint: `Make '${r.name}' optional or give it a default.` });
      }
    }
  }
  return out;
}

/** Same as diff, from the text of both versions (YAML or JSON). */
function diffText(baseText, headText) {
  return diff(YAML.parse(baseText) || {}, YAML.parse(headText) || {});
}

module.exports = { diff, diffText };

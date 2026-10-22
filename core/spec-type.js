'use strict';
// Detects the format of a spec file. Only the root keys are inspected.
const fs = require('fs');
const YAML = require('yaml');

/** @returns {'openapi-3'|'openapi-2'|'asyncapi'|'unknown'} */
function detectSpecTypeFromDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'unknown';
  if (typeof doc.openapi === 'string' || typeof doc.openapi === 'number') {
    return /^3(\.|$)/.test(String(doc.openapi)) ? 'openapi-3' : 'unknown';
  }
  if (doc.swagger !== undefined && /^2\./.test(String(doc.swagger))) return 'openapi-2';
  if (doc.asyncapi !== undefined) return 'asyncapi';
  return 'unknown';
}

function detectSpecType(file) {
  try {
    return detectSpecTypeFromDoc(YAML.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return 'unknown';
  }
}

module.exports = { detectSpecType, detectSpecTypeFromDoc };

'use strict';
// Finds the spec and the collection of the Postman project.
// Source of truth: .postman/resources.yaml (cloudResources.specs / cloudResources.collections keys, relative
// to .postman/). The config can override both (paths relative to the project root).
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { ConfigError } = require('./config');
const { detectSpecType } = require('./spec-type');

const RESOURCES_FILE = path.join('.postman', 'resources.yaml');

/** Keys of cloudResources.<kind> as paths relative to the project root. */
function listResources(cwd, kind) {
  const file = path.join(cwd, RESOURCES_FILE);
  if (!fs.existsSync(file)) return [];
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError([`${RESOURCES_FILE}: not valid YAML (${e.message.split('\n')[0]})`]);
  }
  const keys = Object.keys((doc && doc.cloudResources && doc.cloudResources[kind]) || {});
  return keys.map((k) => path.relative(cwd, path.resolve(cwd, '.postman', k)));
}

function pick(cwd, kind, override, label) {
  if (override) {
    if (!fs.existsSync(path.resolve(cwd, override))) throw new ConfigError([`"${label}" points to "${override}", which does not exist`]);
    return path.normalize(override);
  }
  const found = listResources(cwd, kind);
  if (found.length > 1) {
    throw new ConfigError([
      `${RESOURCES_FILE} declares ${found.length} ${kind}: ${found.join(', ')}. Choose one with "${label}:" in the config file.`,
    ]);
  }
  if (found.length === 1 && !fs.existsSync(path.resolve(cwd, found[0]))) {
    throw new ConfigError([`${RESOURCES_FILE} lists "${found[0]}" but the file does not exist (run "postman workspace pull" or set "${label}:" in the config file)`]);
  }
  return found[0] || null;
}

/**
 * Resolves the gate inputs. spec/collection are null when the project has none (the steps then report
 * not_available); several candidates without a choice is a configuration error.
 */
function resolveInputs(cwd, config) {
  const specPath = pick(cwd, 'specs', config.spec, 'spec');
  const collectionPath = pick(cwd, 'collections', config.collection, 'collection');
  return {
    spec: specPath ? { path: specPath, abs: path.resolve(cwd, specPath), type: detectSpecType(path.resolve(cwd, specPath)) } : null,
    collection: collectionPath ? { path: collectionPath, abs: path.resolve(cwd, collectionPath) } : null,
  };
}

module.exports = { resolveInputs, listResources, RESOURCES_FILE };

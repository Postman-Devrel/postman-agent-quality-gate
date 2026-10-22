'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveInputs, listResources } = require('../core/resources');
const { validateConfig, ConfigError } = require('../core/config');
const { project, fixture } = require('./helpers');

const resources = (specs, collections) => `cloudResources:\n  specs:\n${specs.map((s) => `    ${s}: id\n`).join('')}  collections:\n${collections.map((s) => `    ${s}: id\n`).join('')}`;
const cfg = (o = {}) => validateConfig(o);

test('paths are relative to .postman/ and resolved to the project root', () => {
  const dir = project({ '.postman/resources.yaml': resources(['../api/spec.yaml'], ['../postman/c']), 'api/spec.yaml': 'openapi: 3.0.0', 'postman/c/x.request.yaml': 'a: 1' });
  assert.deepEqual(listResources(dir, 'specs'), ['api/spec.yaml']);
  const r = resolveInputs(dir, cfg());
  assert.equal(r.spec.path, 'api/spec.yaml');
  assert.equal(r.spec.type, 'openapi-3');
  assert.equal(r.collection.path, 'postman/c');
});

test('no .postman/resources.yaml: nothing found, no error', () => {
  const r = resolveInputs(project({}), cfg());
  assert.equal(r.spec, null);
  assert.equal(r.collection, null);
});

test('several specs and none chosen is a configuration error naming the candidates', () => {
  const dir = project({ '.postman/resources.yaml': resources(['../a.yaml', '../b.yaml'], []), 'a.yaml': 'openapi: 3.0.0', 'b.yaml': 'openapi: 3.0.0' });
  assert.throws(() => resolveInputs(dir, cfg()), (e) => e instanceof ConfigError && /2 specs: a\.yaml, b\.yaml.*"spec:"/.test(e.errors[0]));
  assert.equal(resolveInputs(dir, cfg({ spec: 'b.yaml' })).spec.path, 'b.yaml');
});

test('several collections and none chosen is a configuration error', () => {
  const dir = project({ '.postman/resources.yaml': resources([], ['../c1', '../c2']), 'c1/x': '', 'c2/x': '' });
  assert.throws(() => resolveInputs(dir, cfg()), /2 collections/);
  assert.equal(resolveInputs(dir, cfg({ collection: 'c2' })).collection.path, 'c2');
});

test('an override pointing nowhere, or a listed file that is missing, is an error', () => {
  const dir = project({ '.postman/resources.yaml': resources(['../gone.yaml'], []) });
  assert.throws(() => resolveInputs(dir, cfg()), /does not exist/);
  assert.throws(() => resolveInputs(dir, cfg({ spec: 'nope.yaml' })), /"spec" points to "nope.yaml"/);
});

test('a fixture resolves', () => {
  const r = resolveInputs(fixture('green'), cfg());
  assert.equal(r.spec.path, 'specs/pets.yaml');
  assert.equal(r.collection.path, 'collections/Pets API');
});

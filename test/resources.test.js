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

const local = (specs, collections) => `localResources:\n  specs:\n${specs.map((s) => `    - ${s}\n`).join('')}  collections:\n${collections.map((s) => `    - ${s}\n`).join('')}workspace:\n  id: ''\n`;

test('localResources only (fresh postman init): spec and collection resolve', () => {
  const dir = project({ '.postman/resources.yaml': local(['../api/spec.yaml'], ['../postman/c']), 'api/spec.yaml': 'openapi: 3.0.0', 'postman/c/x.request.yaml': 'a: 1' });
  assert.deepEqual(listResources(dir, 'specs'), ['api/spec.yaml']);
  const r = resolveInputs(dir, cfg());
  assert.equal(r.spec.path, 'api/spec.yaml');
  assert.equal(r.collection.path, 'postman/c');
});

test('localResources with a spec and no collection: the collection stays null', () => {
  const dir = project({ '.postman/resources.yaml': 'localResources:\n  specs:\n    - ../openapi.yaml\nworkspace:\n  id: \'\'\n', 'openapi.yaml': 'openapi: 3.0.0' });
  const r = resolveInputs(dir, cfg());
  assert.equal(r.spec.path, 'openapi.yaml');
  assert.equal(r.collection, null);
});

test('cloudResources only still resolves', () => {
  const dir = project({ '.postman/resources.yaml': resources(['../s.yaml'], ['../c']), 's.yaml': 'openapi: 3.0.0', 'c/x': '' });
  assert.equal(resolveInputs(dir, cfg()).spec.path, 's.yaml');
});

test('both: cloud entries win over local ones, per kind', () => {
  const dir = project({
    '.postman/resources.yaml': `${resources(['../cloud.yaml'], [])}${local(['../local.yaml'], ['../lc'])}`.replace(/^localResources/m, 'localResources'),
    'cloud.yaml': 'openapi: 3.0.0', 'local.yaml': 'openapi: 3.0.0', 'lc/x': '',
  });
  const r = resolveInputs(dir, cfg());
  assert.equal(r.spec.path, 'cloud.yaml');
  assert.equal(r.collection.path, 'lc'); // cloud lists no collection: local fills in
});

test('several local specs and none chosen is still a configuration error', () => {
  const dir = project({ '.postman/resources.yaml': local(['../a.yaml', '../b.yaml'], []), 'a.yaml': 'openapi: 3.0.0', 'b.yaml': 'openapi: 3.0.0' });
  assert.throws(() => resolveInputs(dir, cfg()), /2 specs/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { diff, diffText } = require('../steps/adapters/openapi/contract-diff');
const { fixture } = require('./helpers');

const base = () => ({
  paths: {
    '/pets': {
      get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, 404: { description: 'x' } } },
      post: { requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } }, responses: { 201: { description: 'ok' } } },
    },
    '/gone': { get: { responses: { 200: { description: 'ok' } } } },
  },
  components: { schemas: {
    Pet: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
    NewPet: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, tag: { type: 'string' } } },
  } },
});
const clone = (o) => JSON.parse(JSON.stringify(o));
const changes = (h) => diff(base(), h).map((c) => c.change);

test('an identical spec has no change', () => assert.deepEqual(diff(base(), base()), []));

test('additions are not breaking', () => {
  const h = base();
  h.paths['/new'] = { get: { responses: { 200: { description: 'ok' } } } };
  h.components.schemas.Pet.properties.age = { type: 'integer' };
  h.components.schemas.Brand = { type: 'object', required: ['x'], properties: { x: { type: 'string' } } };
  h.paths['/pets'].get.responses[500] = { description: 'new' };
  assert.deepEqual(diff(base(), h), []);
});

test('removed path, operation, response, property', () => {
  const h = base();
  delete h.paths['/gone'];
  delete h.paths['/pets'].post;
  delete h.paths['/pets'].get.responses[404];
  delete h.components.schemas.Pet.properties.name;
  const c = changes(h);
  assert.ok(c.includes('path /gone was removed or renamed'));
  assert.ok(c.includes('POST /pets was removed'));
  assert.ok(c.includes('GET /pets: response 404 was removed'));
  assert.ok(c.some((m) => /GET \/pets response 200: property 'name' was removed or renamed/.test(m)));
});

test('changed property type', () => {
  const h = clone(base());
  h.components.schemas.Pet.properties.id.type = 'string';
  assert.ok(changes(h).some((m) => /property 'id' changed type integer -> string/.test(m)));
});

test('request side: field became required, new required field, body became required, new required parameter', () => {
  const h = clone(base());
  h.components.schemas.NewPet.required = ['name', 'tag'];
  h.components.schemas.NewPet.properties.extra = { type: 'string' };
  h.components.schemas.NewPet.required.push('extra');
  h.paths['/pets'].post.requestBody.required = true;
  h.paths['/pets'].get.parameters = [{ name: 'q', in: 'query', required: true }];
  const c = changes(h);
  assert.ok(c.some((m) => /request field 'tag' became required/.test(m)));
  assert.ok(c.some((m) => /new request field 'extra' is required/.test(m)));
  assert.ok(c.some((m) => /request body became required/.test(m)));
  assert.ok(c.some((m) => /new required parameter 'q'/.test(m)));
});

test('hints never name a project file', () => {
  const h = base();
  delete h.paths['/gone'];
  for (const c of diff(base(), h)) assert.doesNotMatch(c.hint, /\.ya?ml|contract\//);
});

test('breaking-change fixture: base content vs head content, no git needed', () => {
  const dir = fixture('breaking-change');
  const c = diffText(fs.readFileSync(path.join(dir, 'base/pets.yaml'), 'utf8'), fs.readFileSync(path.join(dir, 'specs/pets.yaml'), 'utf8'));
  assert.ok(c.some((x) => /property 'status' was removed or renamed/.test(x.change)));
  assert.deepEqual(diffText(fs.readFileSync(path.join(dir, 'base/pets.yaml'), 'utf8'), fs.readFileSync(path.join(dir, 'base/pets.yaml'), 'utf8')), []);
});

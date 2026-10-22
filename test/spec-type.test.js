'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { detectSpecType, detectSpecTypeFromDoc } = require('../core/spec-type');
const { fixture, project } = require('./helpers');

test('detects the format from the root keys', () => {
  assert.equal(detectSpecTypeFromDoc({ openapi: '3.1.0' }), 'openapi-3');
  assert.equal(detectSpecTypeFromDoc({ openapi: 3.0 }), 'openapi-3');
  assert.equal(detectSpecTypeFromDoc({ swagger: '2.0' }), 'openapi-2');
  assert.equal(detectSpecTypeFromDoc({ asyncapi: '3.0.0' }), 'asyncapi');
  assert.equal(detectSpecTypeFromDoc({ info: {} }), 'unknown');
  assert.equal(detectSpecTypeFromDoc(null), 'unknown');
  assert.equal(detectSpecTypeFromDoc([]), 'unknown');
});

test('detects from files, JSON included, unreadable is unknown', () => {
  assert.equal(detectSpecType(path.join(fixture('green'), 'specs/pets.yaml')), 'openapi-3');
  assert.equal(detectSpecType(path.join(fixture('unsupported-spec'), 'orders.asyncapi.yaml')), 'asyncapi');
  const dir = project({ 's.json': '{"swagger":"2.0"}', 'bad.yaml': 'a: [1,' });
  assert.equal(detectSpecType(path.join(dir, 's.json')), 'openapi-2');
  assert.equal(detectSpecType(path.join(dir, 'bad.yaml')), 'unknown');
  assert.equal(detectSpecType(path.join(dir, 'missing.yaml')), 'unknown');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (rel) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));

test('plugin.json, marketplace.json, package.json and the lockfile carry the same version', () => {
  const pkg = read('package.json');
  const lock = read('package-lock.json');
  const plugin = read('plugin/.claude-plugin/plugin.json');
  const market = read('.claude-plugin/marketplace.json');
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, 'marketplace.json lists the plugin');
  assert.equal(plugin.version, pkg.version, 'plugin.json vs package.json');
  assert.equal(entry.version, pkg.version, 'marketplace.json vs package.json');
  assert.equal(lock.version, pkg.version, 'package-lock.json vs package.json');
  assert.equal(lock.packages[''].version, pkg.version, 'package-lock.json root package vs package.json');
});

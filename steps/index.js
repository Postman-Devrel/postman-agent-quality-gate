'use strict';
// Registry of the steps, in report order. A step is { id, supports, run(ctx) } returning the result contract.
const steps = [
  require('./skills-check'),
  require('./contract-lint'),
  require('./contract-tests'),
  require('./coverage'),
  require('./ai-readiness'),
  require('./impact'),
];
module.exports = { steps, byId: Object.fromEntries(steps.map((s) => [s.id, s])) };

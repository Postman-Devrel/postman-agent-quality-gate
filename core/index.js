'use strict';
const { loadConfig, validateConfig, ConfigError } = require('./config');
const { resolveInputs } = require('./resources');
const { aggregate } = require('./aggregate');
const { detectSpecType } = require('./spec-type');
const { runSteps, buildContext } = require('./runner');
module.exports = { loadConfig, validateConfig, ConfigError, resolveInputs, aggregate, detectSpecType, runSteps, buildContext };

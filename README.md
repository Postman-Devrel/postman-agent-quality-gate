# postman-agent-quality-gate

A quality gate for API projects that depends **only on the Postman project** (spec, collection, workspace): never on the application code or its language. It scores the contract, checks it against the consumers' collection, and flags breaking changes for known consumers. It runs in CI, outside the coding agent, so an agent cannot skip it.

Status: 0.3.0 (not published to npm). Node 22, one runtime dependency (`yaml`), Postman CLI 1.76.0.

## What it judges

| Step | What | Needs login |
|------|------|-------------|
| `skills-check` | Are the Postman skills committed in the repo up to date? | no |
| `contract-lint` | Postman governance rules on the spec (syntax rules only without login) | governance: yes |
| `contract-tests` | The collection runs against a mock generated from the **current** spec; any failed assertion, request error or 0 assertions fails | no |
| `coverage` | Every spec operation has a request in the collection (warn below 100%) | no |
| `ai-readiness` | How well an AI agent can discover, understand and call the API | no |
| `impact` | Known consumers (Postman Context Graph) of the API, and whether the spec change is breaking for them | yes |

Verdict: a weighted score, a rating A to E, and **blockers** declared per step in the config (a failing `contract-lint` or `contract-tests`, a breaking change for a known consumer). A step that ran with a weakened check (for example lint without login) is `degraded`: at best a warning, score capped, shown in the report. A step that cannot run is `not_available`: it is excluded from the score, never counted as a pass, and it blocks when it is in `required_steps` (the rating is then E, whatever the score of the steps that ran).

### What it does not judge

Whether the **code** conforms to the contract. That is the consuming project's own CI (its unit and integration tests). This gate only knows the Postman project; it never builds or runs your application.

## Use it

Requirements: Node 22. The runner is distributed from Git (no npm publish):

```sh
npx github:Postman-Devrel/postman-agent-quality-gate#v1 run                 # every step, then the verdict
npx github:Postman-Devrel/postman-agent-quality-gate#v1 run contract-lint   # one step
npx github:Postman-Devrel/postman-agent-quality-gate#v1 aggregate           # verdict from the step results
```

Options: `--config <file>`, `--results-dir <dir>` (default `gate-results/`), `--no-exit-code`. Exit codes: 0 passed, 1 gate failed, 2 configuration error. The runner calls the `postman` CLI, which must be installed (pinned version: `postmanCli` in `package.json`).

Config reference (`quality-gate.yml`, all optional): `spec`, `collection`, `impact.api`, `steps`, `weights`, `rating`, `pass_rating`, `ai_readiness`, `blockers`, `required_steps`, and `contract-lint.exceptions`: a list of `{ path, issue, reason }` that accepts one lint finding on purpose (exact `path`, case-insensitive `issue` substring, mandatory `reason`). Accepted findings leave the score and the blockers but stay visible in the report. They are human decisions: agents never add them. Details in [docs/adoption.md](docs/adoption.md).

Reference consumer: [`healthcare-org-app/healthcare-appointments`](https://github.com/healthcare-org-app/healthcare-appointments) (a real Python/Flask service) runs this gate in CI and shows a real accepted lint exception. The gate was extracted from the earlier Java prototype `Postman-Devrel/agent-quality-gate`, now deprecated.

Inputs are discovered from `.postman/resources.yaml` (`cloudResources.specs` and `cloudResources.collections`). Nothing to configure for a standard Postman project. See [docs/adoption.md](docs/adoption.md) for the config file, the GitHub workflow and the secrets, and [docs/architecture.md](docs/architecture.md) for the design.

## Outputs

`gate-results/<step>.json` per step, then `report.json` (`schema_version`, `gate_version`, `cli_version`, `spec`, `collection`, `passed`, `score`, `rating`, `blockers`, `feedback[]`, `steps[]` with `accepted_exceptions` when lint exceptions are configured) and `report.md` (posted as a PR comment, marker `<!-- postman-agent-quality-gate -->`).

## Repository

```
bin/        the CLI
core/       config, resource resolver, spec detection, aggregation, report
steps/      one module per step; adapters/openapi/ holds the breaking-change diff
action.yml  composite action (code, pinned Postman CLI, login)
.github/workflows/gate.yml        reusable workflow for projects
.github/workflows/self-test.yml   unit tests + fixtures
fixtures/   green, lint-error, breaking-change, unsupported-spec
test/       node:test, recorded CLI output samples in test/samples
```

Tests: `npm test` (no network). `npm run test:cli` also calls the real Postman CLI on the fixtures (local files and a local mock only; never a real API server).

## Claude Code plugin

The `plugin/` folder is a Claude Code plugin and this repository is its marketplace (`.claude-plugin/marketplace.json`). In a project that uses the gate, in a Claude Code session:

```
/plugin marketplace add Postman-Devrel/postman-agent-quality-gate
/plugin install postman-agent-quality-gate --marketplace Postman-Devrel/postman-agent-quality-gate
```

It ships two things:

- **`gate-verdict` agent** (read-only): given a branch and the exact commit SHA, it finds the `quality-gate` run for that commit (workflow name configurable), waits for it, downloads the `gate-report` artifact, checks `schema_version` and returns `PASSED`, `FAILED` or `SKIPPED` with a numbered fixes brief. `not_available` and degraded steps are listed as gaps, never as a pass. The repository comes from `gh repo view`.
- **`gate-loop` skill**: the loop protocol. Your own coding agent (a subagent, a skill, the main session) works on a branch and pushes; after every push, and on every failing `quality-gate` CI event, `gate-verdict` is called with the branch and SHA; the brief goes word for word to the same coding agent, which pushes to the same branch; stop on PASSED or after 3 rounds, then report rounds, rating per round, what changed and the branch or PR. It never edits the gate, never merges or pushes to the default branch unasked. Local check before pushing: `npx github:Postman-Devrel/postman-agent-quality-gate#v1 run`.

To plug it into your own coder, name `gate-verdict` and `gate-loop` in the coding agent's instructions (for example in `CLAUDE.md`): "after every push, follow the gate-loop skill". The brief is plain text with no tool names, so it works with any coding agent.
## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).

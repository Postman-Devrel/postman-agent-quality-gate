# healthcare-api-quality-gate

The API quality gate of the healthcare-org-app platform. Each service (about 105 across the org) calls it from its own GitHub CI. It scores the service's API contract, checks it against the consumers' collection, and flags breaking changes for known consumers. It runs in CI, outside the coding agent, so an agent cannot skip it.

It reads only the service's Postman project (spec, collection, workspace): never the application code or its language. It is built on the Postman CLI (lint, mock, collection run, AI readiness, skills check), the Postman plugin skills committed in each service, and the Postman Context Graph for the list of known consumers.

Owner: healthcare-org-app platform team. Status: 0.6.0, distributed from this repository (no npm publish). Node 22, one runtime dependency (`yaml`), Postman CLI 1.76.0.

## Services using it

| Repository | Service | Status |
|------------|---------|--------|
| [`healthcare-appointments`](https://github.com/healthcare-org-app/healthcare-appointments) | appointments-service | In CI; one accepted lint exception |
| [`healthcare-patients`](https://github.com/healthcare-org-app/healthcare-patients) | patients-service | Adoption in progress |

To adopt it in a service, see [docs/adoption.md](docs/adoption.md).

## What it judges

| Step | What | Needs login |
|------|------|-------------|
| `skills-check` | Are the Postman skills committed in the repo up to date? | no |
| `contract-lint` | Postman governance rules on the spec (syntax rules only without login) | governance: yes |
| `contract-tests` | The collection runs against a mock generated from the **current** spec; any failed assertion, request error or 0 assertions fails | no |
| `coverage` | Every spec operation has a request in the collection (warn below 100%) | no |
| `ai-readiness` | How well an AI agent can discover, understand and call the API | no |
| `impact` | Known consumers (Postman Context Graph) of the API, and whether the spec change is breaking for them | yes |

Besides the verdict, the gate reports the **quality delta against the base branch**: "this PR improves or degrades API quality by x%" (see [API quality index](#api-quality-delta-against-the-base)).

Verdict: a weighted score, a rating A to E, and **blockers** declared per step in the config (a failing `contract-lint` or `contract-tests`, a breaking change for a known consumer). A step that ran with a weakened check (for example lint without login) is `degraded`: at best a warning, score capped, shown in the report. A step that cannot run is `not_available`: it is excluded from the score, never counted as a pass, and it blocks when it is in `required_steps` (the rating is then E, whatever the score of the steps that ran).

### API quality delta against the base

The headline of every report says where the PR leaves the API compared with the branch it targets:

```
❌ API quality gate: rating D (60/100) · API quality 86 → 72 vs main (−14 pts, −16 %) · breaking change for 32 consumers
✅ API quality gate: PASSED (rating B, 88/100) · API quality 86 → 89 vs main (+3 pts, +3 %) · no breaking change
```

- **API quality index**: the weighted score (same weights, `not_available` steps left out, weights re-normalized) of the steps that describe the API at a commit: `contract-lint`, `contract-tests`, `coverage`, `ai-readiness`. `skills-check` (repo hygiene) and `impact` (it is about the change) are not part of it. Points and percent are both shown; a move of 2 points or less is `stable`.
- **Change risk**: from `impact`: breaking or not, and how many known consumers are affected. It is not a delta.
- **Baseline**: the merge-base with the base branch. In CI, the `gate-report` artifact of the latest successful gate run on that exact commit; if there is none, or its gate version or index settings differ, the four steps are run on a worktree of the base commit. Locally (`run`), the steps are run on the merge-base with the default branch. If neither works, the report says `not comparable`: never a made-up number. `report.json` records `baseline: { ref, sha, source: artifact|rerun|none, gate_version, quality_index, steps }` and `delta: { points, percent, stable }`.
- **Optional ratchet**: `no_regression: { max_drop: <points> }` in `quality-gate.yml` makes a drop larger than `max_drop` a blocker. Off by default; not enforced when there is no comparable baseline.

### What it does not judge

Whether the **code** conforms to the contract. That is the consuming project's own CI (its unit and integration tests). This gate only knows the Postman project; it never builds or runs your application.

## Use it

Requirements: Node 22. The runner is distributed from Git (no npm publish):

```sh
npx github:healthcare-org-app/healthcare-api-quality-gate#v1 run                 # every step, then the verdict
npx github:healthcare-org-app/healthcare-api-quality-gate#v1 run contract-lint   # one step
npx github:healthcare-org-app/healthcare-api-quality-gate#v1 aggregate           # verdict from the step results
```

Options: `--config <file>`, `--results-dir <dir>` (default `gate-results/`), `--no-exit-code`, `--no-baseline` (`run` only: skip the quality delta). Exit codes: 0 passed, 1 gate failed, 2 configuration error. The runner calls the `postman` CLI, which must be installed (pinned version: `postmanCli` in `package.json`).

Config reference (`quality-gate.yml`, all optional): `spec`, `collection`, `impact.api`, `steps`, `weights`, `rating`, `pass_rating`, `ai_readiness`, `blockers`, `required_steps`, `no_regression`, and `contract-lint.exceptions`: a list of `{ path, issue, reason }` that accepts one lint finding on purpose (exact `path`, case-insensitive `issue` substring, mandatory `reason`). Accepted findings leave the score and the blockers but stay visible in the report. They are human decisions: agents never add them. Details in [docs/adoption.md](docs/adoption.md).

Reference consumer: [`healthcare-org-app/healthcare-appointments`](https://github.com/healthcare-org-app/healthcare-appointments) (a Python/Flask service) runs this gate in CI and carries one accepted lint exception.

Inputs are discovered from `.postman/resources.yaml` (`cloudResources.specs` and `cloudResources.collections`). Nothing to configure for a standard Postman project. See [docs/adoption.md](docs/adoption.md) for the config file, the GitHub workflow and the secrets, and [docs/architecture.md](docs/architecture.md) for the design.

## Outputs

`gate-results/<step>.json` per step, then `report.json` (`schema_version`, `gate_version`, `cli_version`, `spec`, `collection`, `commit`, `config_hash`, `passed`, `score`, `rating`, `headline`, `quality_index`, `baseline`, `delta`, `risk`, `no_regression` when the ratchet is set, `blockers`, `feedback[]`, `steps[]` with `accepted_exceptions` when lint exceptions are configured) and `report.md` (posted as a PR comment, marker `<!-- healthcare-api-quality-gate -->`, with a base to head column for the quality steps). When the workflow decides nothing the gate judges changed against the base, `report.json` is `{ skipped: true, ... }` and an existing gate comment on the PR is updated in place to say so (none is created).

## Repository

```
bin/        the CLI
core/       config, resource resolver, spec detection, aggregation, quality index and baseline, report
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
/plugin marketplace add healthcare-org-app/healthcare-api-quality-gate
/plugin install healthcare-api-quality-gate@healthcare-api-quality-gate
```

It ships two things:

- **`gate-verdict` agent** (read-only): given a branch and the exact commit SHA (and the intent of the change), it finds the `quality-gate` run for that commit (workflow name configurable; the repository comes from `git remote get-url origin`), waits for it, downloads the `gate-report` artifact, checks `schema_version` and returns `PASSED`, `FAILED`, `SKIPPED` or `NEEDS_DECISION` with the quality delta against the base, the change risk and a numbered fixes brief. For a breaking rename it recommends the compatible fix (old field kept and `deprecated`, new field added next to it), never a revert. `not_available` and degraded steps are listed as gaps, never as a pass.
- **`gate-loop` skill**: the loop protocol, run by **your own Claude Code session**: no per-repo coding agent. It restates the intent to preserve (PR title and body) every round; after every push, and on every failing `quality-gate` CI event, `gate-verdict` is called with the branch and SHA; the session applies the brief and pushes to the same branch, using the Postman plugin's `postman:api-engineer` skill for the contract, collection and mock. It never reverts or waters down the change to get a green gate, never edits the gate, never merges or pushes to the default branch unasked. It stops on PASSED, after 3 rounds, or on `NEEDS_DECISION` (the only way to pass would break a consumer, undo the change or needs a human decision): the PR is converted to draft, one comment lists the blocker and the options. The final report gives rounds, rating, score and quality delta per round, what changed, the PR link and the gaps. Local check before pushing: `npx github:healthcare-org-app/healthcare-api-quality-gate#v1 run`.

To use it, install the plugin (and the Postman plugin) in your session and say "follow the gate-loop skill" when you change the API. The brief is plain text, so it works with any coder, but nothing needs to be set up in the repository for it.

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).

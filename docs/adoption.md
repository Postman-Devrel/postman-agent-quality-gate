# Adopting the gate

## 1. Have a Postman project

The gate needs `.postman/resources.yaml` (created by `postman init` / the Postman bootstrap) listing one spec and one collection:

```yaml
cloudResources:
  specs:
    ../openapi/openapi.yaml: <spec id>
  collections:
    ../postman/collections/My API: <collection id>
```

Paths are relative to `.postman/`. A spec symlinked to another file works. If several specs or collections are listed, choose one in the config file (the gate stops with a configuration error otherwise).

The collection must use `{{baseUrl}}` as its base URL variable and carry `pm.test` assertions: it is the consumers' expectation. Use a mock-friendly `baseUrl` such as `http://localhost:8080`; the gate never calls a real server.

## 2. Config file (optional)

`quality-gate.yml` at the project root; everything is optional.

```yaml
spec: openapi/openapi.yaml          # only to override .postman/resources.yaml
collection: postman/collections/My API
impact:
  api: my-api-service                # name in the Postman Context Graph. No default: without it, impact is not_available
steps: [contract-lint, contract-tests, coverage, ai-readiness, impact]   # default: all six
weights: { contract-lint: 25, contract-tests: 20, coverage: 5, ai-readiness: 20, impact: 20, skills-check: 10 }
rating: { A: 90, B: 80, C: 70, D: 50 }
pass_rating: B
ai_readiness: { pass_min: 80, warn_min: 60 }
blockers:                            # step: on_fail | on_warn | on_breaking
  contract-lint: on_fail
  contract-tests: on_fail
  impact: on_breaking
required_steps: [contract-lint, contract-tests]   # not_available => blocker
```

An unknown key, step id or invalid value is reported with the file and key; the runner exits 2.

## 3. Secrets and environment

| Variable | Use |
|----------|-----|
| `POSTMAN_API_KEY` | Logs in to Postman (governance lint, YAML run report, Context Graph). Only through the environment, never printed. Without it: syntax-only lint, and `impact` is `not_available`. |
| `GATE_BASE_REF` | Base ref for the breaking-change comparison. Default: the remote default branch (`origin/HEAD`, else `origin/main`, `origin/master`). The comparison uses the merge base. |
| `PQG_RUNNER_COMMAND` | Overrides the runner command quoted in hints (default `npx github:Postman-Devrel/postman-agent-quality-gate#v1`). |

## 4. GitHub Actions

`.github/workflows/quality-gate.yml` in your repository:

```yaml
name: quality-gate
on:
  push:
  pull_request:
  workflow_dispatch:
jobs:
  gate:
    uses: Postman-Devrel/postman-agent-quality-gate/.github/workflows/gate.yml@v1
    with:
      extra-paths: 'src/|openapi/'    # optional: more files that make the gate relevant
    secrets:
      POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
    permissions:
      contents: read
      pull-requests: write
      actions: read
```

Make the `gate / quality-gate` check required to block merges. Inputs: `config`, `extra-paths`, `steps` (JSON list), `working-directory`. See docs/architecture.md for how the gate code gets its version.

## 5. Locally

```sh
npx github:Postman-Devrel/postman-agent-quality-gate#v1 run
```

Needs the `postman` CLI (1.76.0) on the PATH; `postman login` for the full verdict. Results land in `gate-results/` (add it to `.gitignore`).

## Not covered

Whether your code matches the contract. Run your own tests for that in your own CI.

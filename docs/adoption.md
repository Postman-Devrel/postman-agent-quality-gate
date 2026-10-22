# Adopting the gate

## 1. Have a Postman project

The gate reads the Postman project: one OpenAPI 3 spec and one v3 collection, and nothing else (no code, no build). Two ways to declare them. Start with the one that matches your setup.

### Without a Postman workspace (local only)

```sh
postman init            # writes .postman/resources.yaml and postman/skills/, binds your spec
postman collection new "My API"      # scaffolds postman/collections/My API/
```

`postman init` registers the spec under `localResources`, leaves the workspace id empty and creates no collection. The gate reads `cloudResources` only, so tell it where the spec and the collection are in the config file (step 2):

```yaml
# quality-gate.yml
spec: openapi/openapi.yaml
collection: postman/collections/My API
```

Add requests (one `*.request.yaml` per request, see the `collection-schema-v3` skill (in `postman/skills/`) that `init` installs, or `fixtures/green/` in the gate repository for a complete example) and commit `postman/` with the skills `init` wrote: the `skills-check` step needs them.

### With a Postman workspace

If the project is bound to a workspace (`postman init --visibility personal|team`, then push the spec and collection), `.postman/resources.yaml` lists them under `cloudResources` and no config is needed:

```yaml
cloudResources:
  specs:
    ../openapi/openapi.yaml: <spec id>
  collections:
    ../postman/collections/My API: <collection id>
```

Paths are relative to `.postman/`. A spec symlinked to another file works. If several specs or collections are listed, choose one in the config file (the gate stops with a configuration error otherwise). If neither `cloudResources` nor the config names them, every step that reads them is `not_available` and the required steps block the verdict.

### The collection

It must use `{{baseUrl}}` as its base URL variable (set in the collection definition, `variables: { baseUrl: http://localhost:8080 }`) and carry `pm.test` assertions: it is the consumers' expectation. Use a mock-friendly `baseUrl` such as `http://localhost:8080`; the gate never calls a real server (it runs the collection against a mock generated from the spec). `coverage` is the share of spec operations a request exercises: one request per operation (and per documented response you want covered) keeps it at 100%.

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

Add the repository secret `POSTMAN_API_KEY` (Settings, Secrets and variables, Actions) first; without it the cloud-backed steps are `not_available` (and `contract-lint` is syntax-only). Make the `gate / quality-gate` check required to block merges. Inputs: `config`, `extra-paths`, `steps` (JSON list), `working-directory`. See docs/architecture.md for how the gate code gets its version.

## 5. Locally

```sh
npx github:Postman-Devrel/postman-agent-quality-gate#v1 run
```

Needs Node 22+ and the `postman` CLI (1.76.0) on the PATH; `postman login` for the full verdict. Nothing else: no build, no running server. Run it from the folder that holds `.postman/`. Results land in `gate-results/` (add it to `.gitignore`).

Examples of projects that adopt it: `examples/spec-only/` (no code at all, run in CI through `gate.yml` by `self-test`).

## Not covered

Whether your code matches the contract. Run your own tests for that in your own CI.

# Postman CLI inventory (quality gate)

Verified on **Postman CLI 1.76.0** (run with `npx -y postman-cli@1.76.0`, 2026-10-22). The previous inventory was verified on 1.73.0; CI pinned 1.73.0 and the global install was 1.75.0.
"Verified" means the command was executed against the Appointments API repo (`contract/openapi.yaml`, collection `postman/collections/Appointments API`) with all outputs sent to a temp directory. Help text comes from `-h`. Mocks ran on localhost only; no request reached a real server.

Status legend: **OK** = the gate parser still works unchanged, **changed** = works but the shape or behaviour differs, **broken** = the gate would misread it.

| # | Gate step | Command | Status on 1.76.0 |
|---|-----------|---------|------------------|
| 1 | Skills check | `postman skills status --json [--strict]` | changed (works better; `.files` is gone) |
| 2 | Contract lint | `postman spec lint <spec> -o json --no-report-events` | OK |
| 3a | Mock generation | `postman mock generate <spec> -n <name> --port <p> -o <dir> --force` | changed (run ignores the port) |
| 3b | Collection run | `postman collection run <dir> --use-mock "{{baseUrl}} mock:<config.yaml>" --output <dir>` | OK, with a side effect (cloud upload) |
| 3c | Coverage | `postman spec generate collection <spec> -n gen --folder-strategy Tags` | OK |
| 4 | AI readiness | `postman spec ai-readiness <spec> -o json` | OK |
| 4b | AI readiness (collection) | `postman collection ai-readiness <dir> -o json` | OK |
| 5 | Impact | `postman context-graph ask "<q>" --wait --json --timeout 120` | OK, new structured field |
| - | Login | `postman login --with-api-key <key>` | OK (flag still listed; not executed) |

## 1. Skills check

```
postman skills status --json [--strict] [path]
```

Fields the gate reads: `.state`, `.files[].state` (for the details), `.error`.

Status: **changed**.
- States documented in `-h` are now only `current` and `behind`. `modified` and `unknown` are no longer listed, and an edited skill file in a fresh `postman init` repo reported `behind` (verified). Treat those two branches in `01-skills-check.sh` as dead code, but keep them harmless.
- The JSON no longer carries a `files` array or `orphans` (verified in both a pristine repo and the source repo). `jq '.files // []'` still returns an empty list, so nothing breaks, but the details list is always empty.
- The `foreign` problem of 1.73/1.75 is gone. On a pristine `git init && postman init` repo (17 skills) 1.76.0 answers `current`, exit 0. On 1.75.0 the same source repo answered `foreign`. On 1.76.0 the source repo answers `behind`, which is the real answer (the committed skills are older than the published ones).
- Exit codes: 0 = check done, 1 = origin unreachable, 3 = not current with `--strict` (verified: exit 3 in the source repo). `postman skills update` exits 4 when a skill file was edited locally (needs `--force`).

Excerpt (source repo):
```json
{
  "state": "behind",
  "message": "Skills are missing or out of date. Run `postman skills update` to add them."
}
```

## 2. Contract lint

```
postman spec lint contract/openapi.yaml -o json --no-report-events
```

Fields read: `.violations[]` with `severity`, `path`, `issue`, `"line number"`.

Status: **OK**.
- Clean contract: `{"violations": []}`, exit 0.
- Violation keys (verified on a deliberately incomplete spec): `file`, `issue`, `issue type`, `line number`, `path`, `severity`. `severity` is an uppercase string (`"ERROR"`, `"WARNING"`) and `line number` is a string, which the gate's `ascii_downcase` and `tostring` handle.
- Exit 1 when a violation reaches `--fail-severity` (default `ERROR`; `-f warning` also fails on warnings). The gate ignores the exit code and reads the violations.
- Flags: `-f/--fail-severity`, `--issueType syntax`, `-o json|csv`, `--workspace-id`, `--ruleset <path>` (local Spectral ruleset), `--report-events/--no-report-events`. No renamed or deprecated flag.

Excerpt:
```json
{"severity":"WARNING","path":"info","issue":"The info object should have a description.","line number":"2"}
{"severity":"ERROR","path":"paths./x.get","issue":"All of your operations need summaries.","line number":"7"}
```

## 3a. Mock generation

```
postman mock generate contract/openapi.yaml -n appointments-mock --port 4020 -o <dir>/mock --force
```

Status: **changed (behaviour)**, flags unchanged.
- Writes `<dir>/mock/config.yaml` (`version`, `id`, `name`, `slug`, `protocol`, `port`, `scenarios[]`) and `default.js`. Exit 0.
- The `--port` value is stored in `config.yaml`, but `collection run --use-mock` starts the mock on a random free port (49635 in the verified run) and prints it. The gate therefore does not need a free fixed port, and `--port 4010` no longer matters for the collection run.
- New flags: `--stateful` (pm.state CRUD handlers), `-u/--update <mockPath>`, `--deploy`, `-w/--workspace`, `--public`, `-s/--slug`, `--json` (with `--deploy`), `--api-key`, `-x/--suppress-exit-code`.

Excerpt:
```
Mock generated from spec: appointments-mock
  ID:       <mock id>
  Config:   config.yaml
```

## 3b. Collection run against the mock

```
postman collection run "postman/collections/Appointments API" \
  --use-mock "{{baseUrl}} mock:<dir>/mock/config.yaml" --output <dir>/run
```

Fields read: the `*summary.yaml` counters `stats.tests.executed`, `stats.tests.failed`, `stats.executedRequests.errors`, and the `AssertionError` lines in stdout.

Status: **OK** (10 requests, 10 assertions, 0 failed, exit 0), with one side effect.
- `--output` still writes `<slug>-<timestamp>.collection-run-summary.yaml` and `...collection-run-executions.yaml`. The gate's awk on `^  tests:`, `^  executedRequests:`, `executed:`, `failed:`, `errors:` still matches (verified on a passing and on a failing run).
- Failing run (exit 1, 7 of 10 assertions failed): stdout still lists lines like `1.  AssertionError  200 and a page of appointments`, so the `grep -E 'AssertionError'` still works.
- **Side effect:** by default the run uploads the run data to Postman Cloud (the CLI prints an "Uploading Postman CLI run data to Postman Cloud" line, then a link to the run). `--report-events` is on by default. The gate does not pass `--no-report-events`. Add it so CI runs and agent runs do not write to the cloud workspace. With `--no-report-events` no upload line appeared (verified).
- No JSON/JUnit reporter in `collection run -h` (no `-r`). The YAML report is the only machine-readable output.
- The summary has a new top-level `failures[]` (see "New capabilities").
- Run output now also prints "mocked requests" and "mock assertions" rows in the table.

Excerpt (`*summary.yaml`):
```yaml
kind: postman-cli-collection-run-summary
state: completed
stats:
  executedRequests:
    executed: 10
    errors: 0
  tests:
    executed: 10
    failed: 0
failures: []
```

## 3c. Contract coverage (spec to collection)

```
cd <tmp> && git init -q && postman spec generate collection <abs>/contract/openapi.yaml -n gen --folder-strategy Tags
```

Fields read: `*.request.yaml` files with `method:` and `url:`.

Status: **OK**.
- Output goes to `postman/collections/gen/<Tag>/<Name>.request.yaml` (folders `Appointments` and `Health`, 10 requests). Every file has a top-level `method:` and `url:` line.
- URL style unchanged: `{{baseUrl}}/api/appointments/:record_id` (colon path variables, which the gate's sed turns into `{id}`) and query strings kept in the URL.
- New flags: `-w/--workspace` (cloud mode), `--api-key`, `--force`. Output is created under the current directory, hence the temp `git init` dir stays necessary.

Excerpt:
```
method: POST | url: "{{baseUrl}}/api/appointments/:record_id/cancel"
method: GET  | url: "{{baseUrl}}/api/appointments?limit=25&offset=0&status=active"
```

## 4. AI readiness (spec and collection)

```
postman spec ai-readiness contract/openapi.yaml -o json
postman collection ai-readiness "postman/collections/Appointments API" -o json
```

Fields read: `.readiness.score_0_100`, `.readiness.bucket`, `.recommendations[]`.

Status: **OK**.
- Top-level keys unchanged: `complexity, confidence, docCoverage, readiness, recommendations, signals, source, sourceType, stats`. `sourceType` is `specification` or `collection`.
- Current values: spec **70 / "Good"** (confidence high, 8 recommendations), collection **60 / "Good"**. The old inventory recorded 90 / "Excellent" on 1.73.0. 1.75.0 gives the same 70 as 1.76.0, so the scoring changed (or the contract changed) between 1.73.0 and 1.75.0, not in 1.76.0. The gate thresholds (>= 80 pass, 60 to 79 warn) now put the spec in "warn". Not verified which of the two caused the drop.
- `-o` accepts `cli|json|html` (new `html`), `--export <path>` (needs html), `--min-score <n>`.

Excerpt:
```json
{"readiness":{"score_0_100":70,"bucket":"Good"},"confidence":"high","sourceType":"specification"}
```

## 5. Impact (Context Graph)

```
postman context-graph ask "<question>" --wait --json --timeout 120
```

Fields read: `.result.answer` (text, possibly inside a ```` ```json ```` fence).

Status: **OK**. Logged in (existing stored credentials), question for the consumers of `appointments-service`, exit 0, `status: completed`.
- Answer: ```` ```json\n[{"name":"patients-service","endpoint":"GET /api/appointments/","protocol":"http","confidence":0.9}]\n``` ```` . The gate's sed fence stripping still produces valid JSON.
- Top-level keys: `askId, completedAt, completed_at, createdAt, created_at, id, question, result, revision, status`. `result` carries the text `answer`, its `citations` and the `structured` tool results (plus metadata fields not used by the gate).
- **New or newly noticed:** `.result.structured.results[].data.dependencies[]` is a machine-readable list from the typed query (`type: dependencies`, `direction: downstream`). Each item has `api.name`, `api.language`, `protocol`, `dep_type`, `via`, `confidence`, `endpoints_called[]`, `evidence[]`, `first_seen`, `last_seen`. The old inventory said there was no structured consumer list. Not verified whether 1.73.0 already returned it.
- Exit codes (`-h`): 0 completed, 1 request failed, 2 ask reached a failed state, 4 `--timeout` elapsed.
- The question is still answered by an LLM, so the run to run variability that motivated the retries still applies to `.result.answer`, but the typed query behind `structured` is deterministic.

Excerpt:
```json
{"status":"completed","result":{"answer":"...","citations":[{"name":"patients-service"}],
 "structured":{"results":[{"tool":"run_typed_query","data":{"dependencies":[
  {"api":{"name":"patients-service"},"protocol":"http","confidence":0.9,"endpoints_called":["GET /api/appointments/"]}]}}]}}}
```

## Login

`postman login --with-api-key <key>` is still listed in `postman login -h` (also `--alias`, discontinued, and `--region eu`, `--verbose`). Not executed: the stored session was used (`postman whoami` reports a logged-in user). Cloud commands need no extra flag; `POSTMAN_API_KEY` is read by `context-graph ask` and `--api-key` exists on it.

## Changes since 1.73.0 the gate must handle

1. **Skills check:** drop reliance on `.files[]` and on the `modified`/`unknown` states; only `current` and `behind` exist. The `foreign` workaround is no longer needed (the `.py` bug is fixed); keep `foreign` mapped to `not_available` as a safety net.
2. **Collection run:** add `--no-report-events`, otherwise every gate run uploads run data to the Postman Cloud workspace.
3. **Mock port:** do not assume the port given to `mock generate --port`; the run uses a random port. No conflict with other processes on 4010.
4. **AI readiness thresholds:** the spec now scores 70 (Good), so the gate verdict flips from pass to warn compared with the 90 recorded on 1.73.0. Decide whether the 80 threshold stays.
5. **Version pin:** CI can move from 1.73.0 to 1.76.0; no parser change is required for steps 2, 3c, 4 and 5.
6. Cosmetic: the run table now has "mocked requests" and "mock assertions" rows; lint violation severities remain uppercase strings.

## New capabilities worth using

- **`failures[]` in the run summary** (`error.name`, `error.message`, `error.test`, `source.name`): structured failure details with the failing request name and the expectation text. Replaces the stdout `grep AssertionError` and gives the agent a precise fix hint (which request, which keys are missing).
- **`.result.structured` of `context-graph ask`:** consumers with `endpoints_called` and `confidence` without parsing LLM text; likely removes the retry loop for empty answers.
- **`collection lint <dir> -r json`:** native JSON (`diagnostics[]`, `errorCount`, `warningCount`, `filesScanned`) for linting the v3 collection files. Clean on the current collection.
- **`spec sync collection <spec> --dry-run`:** reports what a sync would write or drop; useful to detect drift between spec and collection. (Verified to run read-only; the spec in `postman/specs/appointments-api/index.yaml` maps to a collection named "Orders API", so check the link before relying on it.)
- **`spec ai-readiness -o html --export <path>`** and `--min-score`: shareable report artifact in CI.
- **`mock generate --stateful`:** CRUD handlers backed by `pm.state`, closer to the real service than static examples.
- **`mock run --output ndjson`:** one JSON event per line ending with a summary event, for non-interactive use.
- **`postman describe`** (beta, `instructions [topic]`): agent instructions per topic (discovery, code-generation, maintenance).
- **Not found:** no native JSON/JUnit reporter on `collection run`, no spec diff or breaking-change command (the `contract-diff.py` heuristic stays), no coverage command (the generated-collection comparison stays), and `spec lint`/`spec ai-readiness` help mention OpenAPI only, no AsyncAPI option was seen. Not verified against an AsyncAPI file.

## Not verified

- `postman login --with-api-key` (not executed, to keep the stored credentials untouched).
- `skills status` states `modified` and `unknown` (no longer documented; one edited-file test returned `behind`).
- AsyncAPI input to `spec lint` and `spec ai-readiness`.
- Cross-check with learning.postman.com.

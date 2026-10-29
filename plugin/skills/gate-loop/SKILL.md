---
name: gate-loop
description: Fix loop around the healthcare-api-quality-gate CI gate. Use for any change to the API contract or its Postman collection that will be pushed.
---

# Gate loop

The gate runs in CI, outside the coding agent. This loop takes a change from "pushed" to "the gate agrees", the same way every time, on a pull request or not.

The coder is **the current session** (the developer's own Claude Code); there is no per-repo coding agent. The only other agent is **gate-verdict**, a read-only reviewer.

## Intent to preserve

Before round 1, collect what the change is **for**: PR title and body (`gh pr view --json title,body`), or the branch's commit messages (`git log <default-branch>..HEAD --format=%B`) when there is no PR. If the PR body is empty, use the title and commits, and say so in the final report. Restate it at the top of each round and pass it to gate-verdict. A fix that no longer delivers it is not a fix.

## The loop

1. **Branch.** Work on a branch, never the default branch. Make the change and push. If the loop opens the PR, the body must state the intent. Before pushing, check locally: `npx github:healthcare-org-app/healthcare-api-quality-gate#v1 run` (needs the `postman` CLI; results in `gate-results/`; also reports the gate score against the merge-base). Record the branch and the full commit SHA of the push.
2. **Verdict.** After every push, and on every CI event about a failing `quality-gate` check (including an auto-fix), call the **gate-verdict** agent with the branch, that exact SHA, the intent, and the repository from `git remote get-url origin` (optionally `workflow` when it is not `quality-gate`). It waits for the run and returns a verdict, the quality delta against the base, the change risk and a numbered fixes brief. Do not read CI output yourself; do not fix from the raw CI event.
3. **Fix.** If FAILED, apply the brief yourself, **making the change compatible, never undoing it**, and push to the **same branch**. Before editing the contract, the collection or a mock, load `postman:api-engineer` (fallback: `postman/skills/api-engineer/SKILL.md` in the repo). No ad-hoc scripts on collection YAML. Back to step 2 with the new SHA. For a rename, removal or other consumer-facing break, read `references/compatible-changes.md`.
4. **Stop** on PASSED, NEEDS_DECISION, or after 3 rounds, and report. For NEEDS_DECISION (the only way to pass would break a consumer, undo the change, or needs a human decision), follow `references/needs-decision.md` now: draft the PR with `gh pr ready --undo`, post one comment with the options, push nothing more.

SKIPPED (no relevant file changed) is not a pass: report it as skipped. If the change was meant to touch the contract, say it is no longer in the branch.

## Hard rules

These override the defaults of the Postman skills (e.g. `api-engineer`'s "never block on the human"): when the next step needs a human, stop.

- Never revert, drop or water down the change to get a green gate; make it compatible.
- Rename = keep the old field `deprecated: true`, add the new one (details in `references/compatible-changes.md`).
- Never make an existing request field required.
- Never move or rename the spec, `service.yaml`, the code directory, or the repo or service names.
- Never edit `quality-gate.yml`, `.github/`, `.claude/` or gate exceptions; if the gate looks wrong, say so and stop.
- Never add, edit or remove a lint exception, nor suggest one; flag it for a human and stop that fix.
- Never merge, force-push or push to the default branch unless the user asks.
- A `not_available` or degraded step is a gap, not a pass: name it in the report.
- Never run requests against a real server; the base URL stays local.
- SKIPPED is not a pass.
- Load `postman:api-engineer` before editing the contract, collection or mock.
- Let gate-verdict read CI, not the session.

## Endings

- **PASSED.** Report; say so if PASSED with gaps or accepted exceptions.
- **3 rounds** without PASSED: stop and report what is left.
- **NEEDS_DECISION.** `references/needs-decision.md`.

Report format: `references/final-report.md`.

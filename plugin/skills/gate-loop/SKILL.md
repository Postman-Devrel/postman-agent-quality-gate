---
name: gate-loop
description: The fix loop around the healthcare-api-quality-gate CI gate. Use for any change to the API contract or its Postman collection that will be pushed: branch, push, gate-verdict, fixes applied by the current session, at most 3 rounds, NEEDS_DECISION when only a human can decide, final report.
---

# Gate loop

The gate runs in CI, outside the coding agent. This loop is how a change goes from "pushed" to "the gate agrees", the same way every time, on a pull request or not.

The coder is **the current session** (the developer's own Claude Code). There is no per-repo coding agent to adopt: the session has the Postman plugin, which routes API work to `postman:api-engineer`. The only other agent is **gate-verdict**, a read-only reviewer.

## The intent to preserve

Before round 1, collect what the change is **for**: the PR title and body (`gh pr view --json title,body`), or the branch's commit messages (`git log <default-branch>..HEAD --format=%B`) when there is no PR. Write it down and restate it at the top of each round, and pass it to gate-verdict. A fix that no longer delivers it is not a fix.

## The loop

1. **Branch.** Work on a branch, never on the default branch. Make the change and push. Before pushing, check locally: `npx github:healthcare-org-app/healthcare-api-quality-gate#v1 run` (needs the `postman` CLI; results in `gate-results/`; it also reports the quality delta against the merge-base). Record the branch and the full commit SHA of the push.
2. **Verdict.** After every push, and on every CI event about a failing `quality-gate` check (whoever triggered it, including an auto-fix), call the **gate-verdict** agent with the branch, that exact SHA, the intent to preserve, and the repository from `git remote get-url origin` (optionally `workflow` when it is not `quality-gate`). It waits for the run, reads the gate report and returns a verdict, the quality delta against the base, the change risk and a numbered fixes brief. Do not read the CI output yourself and do not fix from the raw CI event.
3. **Fix.** If the verdict is FAILED, apply the brief yourself, **making the change compatible, never undoing it**, and push to the **same branch**. For the Postman work (contract, collection, mock) use the Postman plugin's `postman:api-engineer` skill (fallback: `postman/skills/api-engineer/SKILL.md` in the repository). Go back to step 2 with the new SHA.
4. **Stop** on PASSED, on NEEDS_DECISION, or after 3 rounds, and report (below).

A SKIPPED verdict (no relevant file changed) is reported as skipped, not as a pass. If the change was meant to touch the contract, a skip means it is no longer in the branch: say so, do not call it green.

## Rules

These take precedence over the defaults of the Postman skills (for example `api-engineer`'s "just do it, never block on the human"): when the next step needs a human, stop.

- **Never revert, drop or water down the change under review to get a green gate.** Make it compatible instead. A gate that is green because the PR is now empty has proved nothing.
- **A rename of a field consumers use**: keep the old field and mark it `deprecated: true` in the contract, add the new field next to it, return both from the code, cover both in the tests and in the collection's assertions. Same idea for a removed path or response: keep it, deprecate it, add the new one.
- Never make an existing request field required: add next to it, or version the API.
- Never edit the gate config (`quality-gate.yml`), `.github/`, `.claude/`, or gate exceptions. If the gate itself looks wrong, say so and stop.
- Never add, edit or remove a lint exception (`contract-lint.exceptions`), and never suggest one as a fix: accepting a finding is a human decision. If an exception looks justified, flag it for a human in the report and stop that fix. A PASSED with accepted exceptions is reported as such.
- Never merge, force-push or push to the default branch unless the user asks for it.
- A `not_available` step (or a degraded one) is a gap, not a pass: name it in the final report.
- Never run requests against a real server: the collection's base URL stays a local one.

## Endings

- **PASSED.** Report. If the verdict says PASSED with gaps or accepted exceptions, say so.
- **3 rounds** without PASSED: stop and report what is left; do not keep looping.
- **NEEDS_DECISION.** The only way to pass would break a consumer, undo the change, or needs a decision only a human can take (a new API version, an accepted exception, a coordinated migration). Then:
  1. stop coding, push nothing more;
  2. convert the PR to draft: `gh pr ready --undo`;
  3. post **one** short PR comment: the blocker, then the options (for example: keep the old field deprecated and add the new one; version the API; accept the break with the consumers' owners);
  4. report, with the PR link. Never merge.

## Final report

- Rounds played, and for each round the rating and score, and the **quality delta against the base** (for example `API quality 86 → 72 vs main, −14 pts, −16 %`, or `not comparable`), with the change risk.
- What changed between rounds (and confirm the intent was kept).
- The PR link or the branch.
- Gaps: `not_available` or degraded steps, a baseline that was not comparable.
- For NEEDS_DECISION: the blocker and the options.

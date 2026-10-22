---
name: gate-loop
description: The fix loop around the postman-agent-quality-gate CI gate. Use for any change to the API contract or its Postman collection that will be pushed: branch, push, gate-verdict, fixes brief to the same coding agent, at most 3 rounds, final report.
---

# Gate loop

The gate runs in CI, outside the coding agent. This loop is how a change goes from "pushed" to "the gate agrees", the same way every time, on a pull request or not.

## The loop

1. **Branch.** Work on a branch, never on the default branch. The project's own coding agent (whatever it is: a subagent, a skill, you) makes the change and pushes. Before pushing, check locally: `npx github:Postman-Devrel/postman-agent-quality-gate#v1 run` (needs the `postman` CLI; results in `gate-results/`). Record the branch and the full commit SHA of the push.
2. **Verdict.** After every push, and on every CI event about a failing `quality-gate` check (whoever triggered it, including an auto-fix), call the **gate-verdict** agent with the branch and that exact SHA (optionally `repo` and `workflow` when they are not `quality-gate`). It waits for the run, reads the gate report and returns a verdict and a numbered fixes brief. Do not read the CI output yourself and do not fix from the raw CI event.
3. **Fix.** If the verdict is FAILED, hand the brief **word for word** to the **same** coding agent (the one that made the change, so it keeps its context), which applies it and pushes to the **same branch**. Go back to step 2 with the new SHA.
4. **Stop** after 3 rounds, or when the verdict is PASSED, and report: rounds played, rating per round, what changed between rounds, the branch or PR link, and the gaps (below).

A SKIPPED verdict (no relevant file changed) is reported as skipped, not as a pass.

## Rules

- Never edit the gate, its workflow or its configuration to get a better verdict. If the gate itself looks wrong, say so and stop.
- Never merge, force-push or push to the default branch unless the user asks for it.
- A `not_available` step (or a degraded one) is a gap, not a pass: name it in the final report.
- Never add, edit or remove a lint exception (`contract-lint.exceptions` in the gate config), and never suggest one as a fix: accepting a finding is a human decision. If an exception looks justified, flag it for a human in the report and stop that fix. A PASSED with accepted exceptions is reported as such.
- Never rename or remove a field, path or response that consumers use, and never make an existing request field required: add next to it, or version the API.
- Never run requests against a real server: the collection's base URL stays a local one.
- After 3 rounds without PASSED, stop and report what is left; do not keep looping.

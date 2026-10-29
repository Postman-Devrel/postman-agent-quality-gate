# Final report

- Rounds played, and for each round the rating and score, and the **quality delta**: the gate score against the base (`score_delta` in `report.json`), as in the first line of the PR comment, for example `API quality is lowered by 21 % from main` (gate score 94 -> 74), or `not comparable`. Add the change risk. The API quality index (delta) is in the comment footer; quote it separately if useful.
- What changed between rounds (and confirm the intent was kept).
- The PR link or the branch.
- Gaps: `not_available` or degraded steps, a baseline that was not comparable.
- For NEEDS_DECISION: the blocker and the options.

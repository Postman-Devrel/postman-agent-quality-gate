# NEEDS_DECISION

The only way to pass would break a consumer, undo the change, or needs a decision only a human can take (a new API version, an accepted exception, a coordinated migration). Then:

1. stop coding, push nothing more;
2. convert the PR to draft: `gh pr ready --undo`;
3. post **one** short PR comment: the blocker, then the options (for example: keep the old field deprecated and add the new one; version the API; accept the break with the consumers' owners);
4. report, with the PR link. Never merge.

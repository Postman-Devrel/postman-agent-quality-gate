# spec-only example

A consumer of the gate with **no code at all**: a spec, a collection and `.postman/resources.yaml`. The gate judges the Postman project, so nothing else is needed. `self-test.yml` runs this folder through the real reusable workflow `gate.yml` (the `reusable-workflow` job).

```sh
npx github:healthcare-org-app/healthcare-api-quality-gate#v1 run   # from this folder
```

The report headline compares the API quality of a branch with its base (`API quality 86 → 89 vs main`); to make a drop a blocker, add `no_regression: { max_drop: 5 }` to a `quality-gate.yml` (see [docs/adoption.md](../../docs/adoption.md)).

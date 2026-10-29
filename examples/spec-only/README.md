# spec-only example

A consumer of the gate with **no code at all**: a spec, a collection and `.postman/resources.yaml`. The gate judges the Postman project, so nothing else is needed. `self-test.yml` runs this folder through the real reusable workflow `gate.yml` (the `reusable-workflow` job).

```sh
npx github:healthcare-org-app/healthcare-api-quality-gate#v1 run   # from this folder
```

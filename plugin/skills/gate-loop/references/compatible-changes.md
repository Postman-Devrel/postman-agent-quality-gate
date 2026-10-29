# Compatible changes

- **Rename of a field consumers use**: keep the old field and mark it `deprecated: true` in the contract, add the new field next to it, return both from the code, cover both in the tests and in the collection's assertions.
- **Removed path or response**: keep it, deprecate it, add the new one.
- **New required input**: never make an existing request field required; add next to it, or version the API.
- If the only compatible option is a new API version, an accepted exception or a coordinated migration, that is NEEDS_DECISION: see `needs-decision.md`.

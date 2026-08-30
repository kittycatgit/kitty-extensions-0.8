# Kitty Extensions (0.8)

Paperback **0.8** extensions by kittycatgit.

Separate from the 0.9 repository on purpose: 0.8 is a different API with its own
toolchain, types and source shape, not a dialect of 0.9. Nothing is shared
between them.

- toolchain / types: `@paperback/toolchain` and `@paperback/types` on the `0.8` line
- CLI: `paperback` (0.9 uses `paperback-cli`)

## Scripts

| command               | does                                    |
| --------------------- | --------------------------------------- |
| `npm run bundle`      | build every source and write `bundles/` |
| `npm run serve`       | build and serve locally on port 8080    |
| `npm run conformance` | typecheck, lint and format checks       |
| `npm test`            | run the source tests                    |
| `npm run logcat`      | stream device logs                      |

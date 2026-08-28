# Agent guidance

- This package owns DAP host semantics. A binding (debugpy, delve, …) owns process and protocol facts only; see `docs/PROMISE.md` for the line.
- Never copy a schema in. Change `hostproto-semantics.lock.json` and run `npm run schemas`. Bindings pin this package by commit.
- Never hand-write a TypeScript interface for a HostProto type; validate with `assertValid`.
- A semantic change needs a case in `tests/promise.test.ts` against the fake engine first; the real-engine adapters confirm it afterwards.
- Run `npm test` and `npx tsc -p tsconfig.json` before committing; bindings run `npm ci` against the new commit.

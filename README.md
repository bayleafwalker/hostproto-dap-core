# hostproto-dap-core

The HostProto semantics for Debug Adapter Protocol hosts, once. A debugger
becomes a HostProto host by supplying an `EngineBinding` (how to start it,
what `launch` says, what it cannot do); the core computes revision, cursor,
revision-scoped targets, preconditions, receipts, deviations, recovery, the
earned capability profile, and serves the MCP 2026-07-28 surface with the
pinned [hostproto-semantics](https://github.com/bayleafwalker/hostproto-semantics)
bundles as tool schemas. See `docs/PROMISE.md`.

Bindings: [hostproto-dap-debugpy](https://github.com/bayleafwalker/hostproto-dap-debugpy)
(Python), [hostproto-dap-delve](https://github.com/bayleafwalker/hostproto-dap-delve) (Go).
Both were full adapters first; the core was extracted once they agreed
file-for-file on everything but the seam (hostproto-semantics ADR-0012).

## Use

```ts
import { serve, DapClient, type EngineBinding } from 'hostproto-dap-core';
const binding: EngineBinding = { kind: 'mydbg', variant: 'x', serverName: 'hostproto-dap-mydbg', launchDescription: '…',
  async start(cwd) { return { client: DapClient.spawn('mydbg', ['--dap'], cwd) }; },
  initializeArguments: () => ({ adapterID: 'mydbg' }),
  launchArguments: (p, program, cwd) => ({ request: 'launch', program, cwd, stopOnEntry: true }),
  identity: caps => ({ dap: 'mydbg' }) };
serve(binding);
```

Depend on it by commit: `"hostproto-dap-core": "github:bayleafwalker/hostproto-dap-core#<sha>"`.
`prepare` fetches the pinned bundles (offline: `HOSTPROTO_SEMANTICS_DIR`) and builds.

```sh
npm ci && npm run schemas && npm test   # the promise, against a scripted engine
```

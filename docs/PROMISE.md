# The core promise

`hostproto-dap-core` is the HostProto semantics for Debug Adapter Protocol
hosts, once, behind one seam. A binding says how to start an engine and what
its `launch` looks like; the core does the rest and is tested without any
engine (`tests/promise.test.ts`, against a scripted DAP server).

## What every binding gets, unchanged

| Semantic | Where |
| --- | --- |
| `handles/v1`: host = adapter process, context = launch, surface = thread; `creating` until the first thread exists | `DapHost.createContext` |
| **revision per thread**, moved on every stopped↔running transition; `allThreadsStopped` stamps every surface with the reason and the stopping thread | `onEvent` |
| **host-assigned cursor** over normalized events; the engine's `seq` is raw provenance on each event | `emit` |
| `target-ref/v1` for frames, scopes, variables, scoped to the revision they were observed at; **refused before anything is sent** when the revision moved | `checkTarget` |
| projections that need a stopped thread are **omitted, not lost** (`bounded.omitted`, `lossy: false`, a deviation) | `observe` |
| explicit loss when bounded, with a content-addressed raw copy | `observe` |
| preconditions (`stopped`, `thread_id`, `revision`) checked before the host | `checkPreconditions` |
| `receipt/v1` with `attempted / accepted / executed / verified` and `outcome` incl. `unknown` for a resume whose deadline elapsed | `act` |
| a step pre-empted by a breakpoint: effects ≠ declared, `completed`, a divergence | `act` |
| breakpoint binding recorded per item; unbound and relocated items are deviations | `act` |
| `set_variable` earns `verified` by an independent read | `act` |
| an engine that sends no `continued`: running applied from the response, with an `unmapped_event` deviation | `act` |
| reverse requests as host requests behind a `decision_token`, `allow`/`deny` | `onReverseRequest`, `act` |
| `recovery/v1` with the raw DAP message log as content-addressed evidence | `recovery`, `messageLog` |
| `capability-profile/v1` with availability from the engine's `initialize`, `runtime` earned by execution, unsupported names from the binding | `capabilityProfile` |
| the MCP 2026-07-28 surface: tools whose schemas are the pinned bundles verbatim, subscribable surface state, evidence resources | `createServer`, `serve` |

Every object above is validated against the pinned hostproto-semantics
bundle before it leaves the process. The core pins the bundles by digest
(`hostproto-semantics.lock.json`); a binding pins the core by commit.

## What a binding must supply

`EngineBinding` in `src/host.ts`: `kind`, `variant`, `serverName`,
`launchDescription`, `start()`, `initializeArguments()`,
`launchArguments()`, `identity()`; optionally `launchSchema`, `validate()`,
`handlesBeforeLaunch()`, `unsupported`, `entryDeadlineMs`, and a stdio hook
when the engine puts debuggee output on its own stdio.

## What a binding must not do

Compute a revision, mint a target, decide `verified`, or add a projection or
intent kind of its own. If an engine needs one of those, that is a core
change with a test in `promise.test.ts`, or a HostProto change with an ADR
in hostproto-semantics — never a private rule in a binding.

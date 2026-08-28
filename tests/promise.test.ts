// The core's promise, tested against a scripted engine: every semantic the
// host computes is exercised here without any real debugger's opinions.
import { afterEach, describe, expect, it } from 'vitest';
import { DapHost, validator, type LaunchParams } from '../src/index.js';
import { FakeEngine, fakeBinding, type Quirks } from './fake-engine.js';

type J = Record<string, any>;
const intent = (surface: string, kind: string, extra: J = {}) => ({ schema_version: 'hostproto.intent/v1', action_id: `a-${Math.random().toString(36).slice(2, 8)}`, surface, kind, ...extra });
let engine: FakeEngine; let host: DapHost;
async function boot(quirks: Quirks = {}, params: Partial<LaunchParams> = {}) {
  engine = new FakeEngine(6); await engine.listen();
  host = new DapHost(fakeBinding(engine, quirks));
  const handles = await host.createContext({ program: 'program.txt', cwd: '/fake', ...params }) as J;
  return handles;
}
afterEach(async () => { await host?.close(); engine?.close(); });

describe('the promise: what every binding gets', () => {
  it('handles, entry stop, and a validated capability profile with earned verification', async () => {
    const h = await boot();
    expect(validator('handles')(h)).toBe(true);
    expect(h.adapter_profile).toBe('dap/v1');
    const { observation } = await host.observe({ surface: h.surface.id, projections: ['state'] });
    expect((observation.data as J).state).toMatchObject({ stopped: true, reason: 'entry', line: 1 });
    const profile = host.capabilityProfile() as J;
    expect(validator('capability-profile')(profile)).toBe(true);
    expect(profile.capabilities['context.launch'].verification).toBe('runtime');
    expect(profile.capabilities['act.continue'].verification).toBe('source-audit');
    expect(profile.capabilities['act.restart_frame'].availability).toBe('supported');
    expect(profile.capabilities['act.step_back'].availability).toBe('unsupported');
  });

  it('revision moves on every stop and resume; targets from an earlier revision are refused before send', async () => {
    const h = await boot(); const s = h.surface.id;
    await host.act(intent(s, 'set_breakpoints', { params: { source: 'program.txt', lines: [4] } }));
    const r1 = await host.act(intent(s, 'continue')) as J;
    expect(validator('receipt')(r1)).toBe(true);
    expect(r1.effects.map((e: J) => e.kind)).toEqual(['continued', 'stopped']);
    expect(r1.revision_after).toBe(r1.revision_before + 2);
    const frames = ((await host.observe({ surface: s, projections: ['frames'] })).observation.data as J).frames;
    const scopes = ((await host.observe({ surface: s, projections: ['scopes'], target: frames[0] })).observation.data as J).scopes;
    const vars = ((await host.observe({ surface: s, projections: ['variables'], target: scopes[0] })).observation.data as J).variables;
    expect(vars[0].name).toBe('count = 17'); expect(vars[0].revision).toBe(r1.revision_after);
    await host.act(intent(s, 'step_over'));
    const quiet = engine.seq;
    await expect(host.observe({ surface: s, projections: ['variables'], target: scopes[0] })).rejects.toMatchObject({ code: 'target_invalidated', hostInvoked: false });
    await expect(host.act(intent(s, 'evaluate', { target: frames[0], params: { expression: 'count' } }))).rejects.toMatchObject({ code: 'target_invalidated', hostInvoked: false });
    expect(engine.seq).toBe(quiet); // nothing reached the engine for either refusal
  });

  it('a step pre-empted by a breakpoint: declared and observed differ, outcome stays completed', async () => {
    const h = await boot(); const s = h.surface.id;
    await host.act(intent(s, 'set_breakpoints', { params: { source: 'program.txt', lines: [2, 99] } })).then((r: J) => {
      expect(r.effects[0].breakpoints[1].verified).toBe(false); expect(r.verified).toBe(true); expect(r.deviations[0].reason).toMatch(/did not bind/);
    });
    const r = await host.act(intent(s, 'step_over', { declared_effects: ['stopped:step'] })) as J;
    expect(r.outcome).toBe('completed'); expect(r.effects[1]).toMatchObject({ kind: 'stopped', reason: 'breakpoint', line: 2 });
    expect(r.deviations.some((d: J) => /pre-empted/.test(d.reason))).toBe(true);
  });

  it('a resume that never stops is outcome=unknown; frames while running are omitted, not lost; pause reconciles', async () => {
    const h = await boot({ spin: true }); const s = h.surface.id;
    const r = await host.act(intent(s, 'continue', { params: { deadline_ms: 100 } })) as J;
    expect(r).toMatchObject({ outcome: 'unknown', executed: false, verified: false });
    const { observation } = await host.observe({ surface: s, projections: ['state', 'frames'] });
    expect((observation.data as J).state.stopped).toBe(false);
    expect(observation.bounded).toMatchObject({ lossy: false, omitted: { frames: 1 } });
    const p = await host.act(intent(s, 'pause')) as J;
    expect(p.effects[0]).toMatchObject({ kind: 'stopped', reason: 'pause' });
  });

  it('an engine that sends no `continued` gets the running transition from the response, with a deviation', async () => {
    const h = await boot({ noContinued: true, spin: true }); const s = h.surface.id;
    const r = await host.act(intent(s, 'continue', { params: { deadline_ms: 300 } })) as J;
    expect(r.outcome).toBe('unknown');
    expect(r.deviations.some((d: J) => d.kind === 'unmapped_event')).toBe(true);
    expect(((await host.observe({ surface: s, projections: ['state'] })).observation.data as J).state.stopped).toBe(false);
  });

  it('set_variable earns verified by read-back; preconditions are checked before the host', async () => {
    const h = await boot(); const s = h.surface.id;
    const frames = ((await host.observe({ surface: s, projections: ['frames'] })).observation.data as J).frames;
    const scopes = ((await host.observe({ surface: s, projections: ['scopes'], target: frames[0] })).observation.data as J).scopes;
    const vars = ((await host.observe({ surface: s, projections: ['variables'], target: scopes[0] })).observation.data as J).variables;
    const r = await host.act(intent(s, 'set_variable', { target: vars[0], params: { value: '5' } })) as J;
    expect(r.verified).toBe(true); expect(r.effects[0].read_back).toBe('5');
    await expect(host.act(intent(s, 'step_in', { preconditions: { schema_version: 'hostproto.precondition/v1', surface: s, assertions: [{ field: 'stopped', equals: false }] } }))).rejects.toMatchObject({ code: 'precondition_failed', hostInvoked: false });
  });

  it('a reverse request is a host request behind a decision token; handles come first', async () => {
    const h = await boot({ terminal: true }); const s = h.surface.id;
    expect(h.surface.lifecycle).toBe('creating');
    await host.await({ surface: s, conditions: [{ kind: 'host_request', equals: true }], deadline_ms: 3000 });
    const req = ((await host.observe({ surface: s, projections: ['host_requests'] })).observation.data as J).host_requests[0];
    expect(req).toMatchObject({ command: 'runInTerminal', status: 'pending' });
    const r = await host.act(intent(s, 'host_request.resolve', { decision_token: req.token, params: { decision: 'allow' } })) as J;
    expect(r.provider).toBe('host');
    await host.await({ surface: s, conditions: [{ kind: 'stopped', equals: true }], deadline_ms: 3000 });
    await expect(host.act(intent(s, 'host_request.resolve', { decision_token: req.token, params: { decision: 'deny' } }))).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  it('exit terminates the surface, expires handles, and recovery carries the message log as evidence', async () => {
    const h = await boot(); const s = h.surface.id;
    const r = await host.act(intent(s, 'continue')) as J;
    expect(r.effects.map((e: J) => e.kind)).toEqual(['continued', 'terminated']);
    const out = ((await host.observe({ surface: s, projections: ['output'] })).observation.data as J).output.map((e: J) => e.payload.output).join('');
    expect(out).toContain('count: 17'); expect(out).toContain('done');
    await expect(host.act(intent(s, 'continue'))).rejects.toMatchObject({ code: 'handle_expired', hostInvoked: false });
    const rec = host.recovery(h.context.id) as J;
    expect(validator('recovery')(rec)).toBe(true);
    expect(rec).toMatchObject({ outcome: 'unrecoverable', cause: 'host_terminated' });
    expect(rec.evidence[0].size_bytes).toBe(host.messageLog(h.context.id)!.bytes.length);
  });

  it('a launch that fails is host_failed, not a hang', async () => {
    engine = new FakeEngine(6); await engine.listen();
    const binding = fakeBinding(engine); binding.launchArguments = () => ({ request: 'launch', program: 'x' });
    // the fake responds success to launch; make start() fail instead to cover the other path
    binding.start = async () => { throw new Error('no engine here'); };
    host = new DapHost(binding);
    await expect(host.createContext({ program: 'p', cwd: '/fake' })).rejects.toMatchObject({ code: 'host_failed', hostInvoked: true });
  });
});

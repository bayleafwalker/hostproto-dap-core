// A scripted DAP engine over loopback TCP. No debugger: a deterministic
// program of N lines, one thread, breakpoints, stepping, a spin mode that
// never stops, optional quirks (no `continued` event; a runInTerminal
// reverse request before initialized). It exists so the core's promise can
// be tested without any engine's opinions.
import { createServer, type Server, type Socket } from 'node:net';
import { DapClient, type EngineBinding, type LaunchParams } from '../src/index.js';

type J = Record<string, unknown>;
export interface Quirks { noContinued?: boolean; terminal?: boolean; spin?: boolean }

export class FakeEngine {
  server!: Server; port = 0;
  seq = 0; sock?: Socket; line = 1; running = false; exited = false;
  breakpoints = new Map<number, number>(); nextBp = 1;
  vars: Record<string, number> = { count: 17 }; quirks: Quirks = {};
  pendingRit?: number;
  constructor(readonly lastLine = 6) {}
  async listen() { this.server = createServer(s => this.accept(s)); await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r)); this.port = (this.server.address() as { port: number }).port; }
  close() { this.sock?.destroy(); this.server.close(); }
  private send(m: J) { const body = Buffer.from(JSON.stringify({ seq: ++this.seq, ...m })); this.sock!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])); }
  event(event: string, body: J = {}) { this.send({ type: 'event', event, body }); }
  private respond(req: J, body: J = {}, success = true, message?: string) { this.send({ type: 'response', request_seq: req.seq, success, command: req.command, body, ...(message ? { message } : {}) }); }
  private accept(sock: Socket) {
    this.sock = sock; let buf = Buffer.alloc(0);
    sock.on('data', c => { buf = Buffer.concat([buf, c]); for (;;) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, i).toString())![1]); if (buf.length < i + 4 + len) return; const msg = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString()) as J; buf = buf.subarray(i + 4 + len); this.handle(msg); } });
  }
  private stop(reason: string, extra: J = {}) { this.running = false; this.event('stopped', { reason, threadId: 1, allThreadsStopped: true, ...extra }); }
  private resume() { this.running = true; if (!this.quirks.noContinued) this.event('continued', { threadId: 1, allThreadsContinued: true }); }
  /** Advance until a breakpoint, the end, or forever in spin mode. */
  private run(from: number, stepping: boolean) {
    this.resume();
    if (this.quirks.spin) return; // never stops on its own
    setTimeout(() => {
      for (let l = from + 1; l <= this.lastLine; l++) {
        if (this.breakpoints.has(l)) { this.line = l; this.stop('breakpoint', { hitBreakpointIds: [this.breakpoints.get(l)] }); return; }
        if (stepping) { this.line = l; this.stop('step'); return; }
        if (l === 3) this.event('output', { category: 'stdout', output: `count: ${this.vars.count}\n` });
      }
      this.exited = true; this.event('output', { category: 'stdout', output: 'done\n' });
      this.event('thread', { reason: 'exited', threadId: 1 }); this.event('exited', { exitCode: 0 }); this.event('terminated', {});
    }, 20);
  }
  private handle(req: J) {
    if (req.type === 'response') { if (req.request_seq === this.pendingRit) { this.pendingRit = undefined; if (req.success) this.boot(); else this.event('terminated', {}); } return; }
    const a = (req.arguments ?? {}) as J;
    switch (req.command) {
      case 'initialize': this.respond(req, { supportsConfigurationDoneRequest: true, supportsStepBack: false, supportsRestartFrame: true }); return;
      case 'launch': this.respond(req, {}); if (this.quirks.terminal) { this.pendingRit = this.seq + 1; this.send({ type: 'request', command: 'runInTerminal', arguments: { kind: 'integrated', args: ['true'], cwd: '/' } }); } else this.boot(); return;
      case 'configurationDone': this.respond(req); this.event('thread', { reason: 'started', threadId: 1 }); this.stop('entry'); return;
      case 'setBreakpoints': { this.breakpoints.clear(); const out = ((a.breakpoints as J[]) ?? []).map(b => { const line = Number(b.line); if (line > this.lastLine) return { verified: false, line, message: 'no such line' }; const id = this.nextBp++; this.breakpoints.set(line, id); return { id, line, verified: true }; }); this.respond(req, { breakpoints: out }); return; }
      case 'continue': this.respond(req, { allThreadsContinued: true }); this.run(this.line, false); return;
      case 'next': case 'stepIn': case 'stepOut': this.respond(req); this.run(this.line, true); return;
      case 'pause': this.respond(req); setTimeout(() => this.stop('pause'), 10); return;
      case 'stackTrace': this.respond(req, { stackFrames: [{ id: 100 + this.line, name: 'main', line: this.line, source: { path: '/fake/program.txt' } }], totalFrames: 1 }); return;
      case 'scopes': this.respond(req, { scopes: [{ name: 'Locals', variablesReference: 1000 + this.line }] }); return;
      case 'variables': this.respond(req, { variables: Object.entries(this.vars).map(([name, value]) => ({ name, value: String(value), variablesReference: 0 })) }); return;
      case 'evaluate': this.respond(req, { result: String(this.vars[String(a.expression)] ?? 'undefined'), variablesReference: 0 }); return;
      case 'setVariable': this.vars[String(a.name)] = Number(a.value); this.respond(req, { value: String(a.value) }); return;
      case 'disconnect': this.respond(req); this.sock?.end(); return;
      default: this.respond(req, {}, false, `unsupported: ${req.command}`);
    }
  }
  private boot() { this.event('initialized'); }
}

export function fakeBinding(engine: FakeEngine, quirks: Quirks = {}): EngineBinding {
  engine.quirks = quirks;
  return {
    kind: 'fake', variant: 'scripted', serverName: 'hostproto-dap-fake', launchDescription: 'A scripted engine.',
    async start() { return { client: await DapClient.connect('127.0.0.1', engine.port) }; },
    initializeArguments: () => ({ adapterID: 'fake', supportsRunInTerminalRequest: true }),
    launchArguments: (p: LaunchParams, program: string) => ({ request: 'launch', program, stopOnEntry: p.stop_on_entry ?? true }),
    handlesBeforeLaunch: () => Boolean(quirks.terminal),
    identity: () => ({ dap: 'fake' }),
    entryDeadlineMs: 5000,
  };
}

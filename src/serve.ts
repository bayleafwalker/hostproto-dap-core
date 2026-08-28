import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DapHost, type EngineBinding } from './host.js';
import { createServer } from './server.js';

/** Run one binding as a stdio MCP server, rejecting pre-2026-07-28 openings. */
export function serve(binding: EngineBinding, version = '0.0.1'): DapHost {
  const host = new DapHost(binding);
  const handle = serveStdio(() => createServer(host, version), { legacy: 'reject', onerror: e => console.error('[hostproto]', e.message) });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void host.close().finally(() => process.exit(0)); });
  void handle;
  return host;
}

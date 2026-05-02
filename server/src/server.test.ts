import { describe, test, expect } from 'bun:test';
import type { WhatsAppManager } from './whatsapp.js';
import { createMcpRouter } from './server.js';

class FakeWhatsApp {
  isConnected() { return true; }
  getAuthStatus() { return { connected: true, phoneNumber: '0000', lastActivity: Date.now() }; }
  async sendMessage() { return { messageId: 'm', timestamp: 0 }; }
  async waitForReply() { return ''; }
  async sendAndWait() { return ''; }
  async listChats() { return []; }
  async getMessages() { return []; }
  async showQRCode() { return { message: 'no qr' }; }
  checkInbox() { return []; }
  async connect() { /* no-op */ }
  async disconnect() { /* no-op */ }
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};

function rpc(router: ReturnType<typeof createMcpRouter>, body: unknown, sessionId?: string, method = 'POST') {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return router.fetch(
    new Request('http://test/mcp', {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    }),
  );
}

describe('createMcpRouter — per-session transport routing', () => {
  test('two concurrent initialize calls each get a distinct session id', async () => {
    const router = createMcpRouter(new FakeWhatsApp() as unknown as WhatsAppManager);
    const [r1, r2] = await Promise.all([rpc(router, INIT_BODY), rpc(router, INIT_BODY)]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const s1 = r1.headers.get('mcp-session-id');
    const s2 = r2.headers.get('mcp-session-id');
    expect(s1).toBeTruthy();
    expect(s2).toBeTruthy();
    expect(s1).not.toBe(s2);
    expect(router.activeSessionCount()).toBe(2);
  });

  test('initialize without an existing session id returns a fresh one', async () => {
    const router = createMcpRouter(new FakeWhatsApp() as unknown as WhatsAppManager);
    const r = await rpc(router, INIT_BODY);
    expect(r.status).toBe(200);
    expect(r.headers.get('mcp-session-id')).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('non-initialize request without a session id is rejected with 400', async () => {
    const router = createMcpRouter(new FakeWhatsApp() as unknown as WhatsAppManager);
    const r = await rpc(router, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error.code).toBe(-32000);
  });

  test('non-initialize request with an unknown session id is rejected with 400', async () => {
    const router = createMcpRouter(new FakeWhatsApp() as unknown as WhatsAppManager);
    const r = await rpc(router, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 'does-not-exist');
    expect(r.status).toBe(400);
  });

  test('DELETE on an active session removes it from the routing map', async () => {
    const router = createMcpRouter(new FakeWhatsApp() as unknown as WhatsAppManager);
    const init = await rpc(router, INIT_BODY);
    const sid = init.headers.get('mcp-session-id')!;
    expect(router.activeSessionCount()).toBe(1);

    await rpc(router, undefined, sid, 'DELETE');
    expect(router.activeSessionCount()).toBe(0);
  });

  test('a hundred concurrent initialize calls all succeed', async () => {
    const router = createMcpRouter(new FakeWhatsApp() as unknown as WhatsAppManager);
    const responses = await Promise.all(Array.from({ length: 100 }, () => rpc(router, INIT_BODY)));
    const ids = new Set(responses.map((r) => r.headers.get('mcp-session-id')));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(ids.size).toBe(100);
    expect(router.activeSessionCount()).toBe(100);
  });
});

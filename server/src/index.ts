#!/usr/bin/env bun

/**
 * WhatsApp Bridge MCP Server — entrypoint.
 *
 * Streamable-HTTP MCP server that lets multiple concurrent Claude Code sessions
 * share one WhatsApp Web session. WhatsApp protocol allows exactly one connection
 * per phone, so a single persistent bridge owns the session and fans out MCP
 * tool calls to all connected clients via per-session transports (see server.ts).
 */

import { WhatsAppManager } from './whatsapp.js';
import { createMcpRouter } from './server.js';

async function main() {
  const authDir = process.env.WHATSAPP_AUTH_DIR?.replace('~', process.env.HOME || '');
  const defaultRecipient = process.env.WHATSAPP_DEFAULT_RECIPIENT;

  console.error('[WhatsApp Bridge] Starting MCP server...');

  const whatsapp = new WhatsAppManager(authDir);
  const router = createMcpRouter(whatsapp, defaultRecipient);

  const host = process.env.WHATSAPP_MCP_HOST ?? '127.0.0.1';
  const port = parseInt(process.env.WHATSAPP_MCP_PORT ?? '8014', 10);

  Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/mcp') return router.fetch(req);
      if (url.pathname === '/healthz') {
        return Response.json({
          ok: true,
          whatsapp: whatsapp.getAuthStatus(),
          activeSessions: router.activeSessionCount(),
        });
      }
      return new Response('Not found', { status: 404 });
    },
  });

  console.error(`[WhatsApp Bridge] MCP HTTP server listening on http://${host}:${port}/mcp`);

  whatsapp.connect().then(() => {
    const status = whatsapp.getAuthStatus();
    if (status.connected) {
      console.error(`[WhatsApp Bridge] Connected as +${status.phoneNumber}`);
    } else {
      console.error('[WhatsApp Bridge] Use show_qr_code tool to authenticate');
    }
  }).catch(() => {
    console.error('[WhatsApp Bridge] Connection pending — use show_qr_code to authenticate');
  });

  const shutdown = async () => {
    console.error('\n[WhatsApp Bridge] Shutting down...');
    await router.closeAll();
    await whatsapp.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[WhatsApp Bridge] Fatal error:', error);
  process.exit(1);
});

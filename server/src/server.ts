/**
 * WhatsApp Bridge — MCP server factory and Streamable-HTTP router.
 *
 * The Streamable-HTTP transport in @modelcontextprotocol/sdk is per-session: one
 * transport instance corresponds to one client session, and reusing a single
 * transport for multiple concurrent clients triggers "Server already initialized"
 * on the second `initialize` call.
 *
 * `createMcpRouter` keeps a Map<sessionId, transport>, peeks each incoming POST
 * to detect `initialize` requests, and provisions a fresh transport + Server pair
 * per session. All sessions share the same WhatsApp manager singleton, since
 * WhatsApp Web allows exactly one device connection per phone number.
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { WhatsAppManager } from './whatsapp.js';

const TOOL_DEFS = [
  {
    name: 'send_message',
    description: 'Send a WhatsApp message to a contact',
    inputSchema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: 'Phone number (with country code, e.g., "+1234567890") or WhatsApp JID',
        },
        message: { type: 'string', description: 'The message to send' },
      },
      required: ['recipient', 'message'],
    },
  },
  {
    name: 'wait_for_reply',
    description: 'Wait for the user to reply to a previous message',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Specific chat to wait for (defaults to last message recipient)',
        },
        timeout_seconds: {
          type: 'number',
          description: 'How long to wait in seconds (default: 300 = 5 minutes)',
        },
      },
    },
  },
  {
    name: 'send_and_wait',
    description: "Send a message and wait for the user's reply in one step",
    inputSchema: {
      type: 'object',
      properties: {
        recipient: {
          type: 'string',
          description: 'Phone number (with country code) or WhatsApp JID',
        },
        message: { type: 'string', description: 'The message to send' },
        timeout_seconds: {
          type: 'number',
          description: 'How long to wait for reply in seconds (default: 300)',
        },
      },
      required: ['recipient', 'message'],
    },
  },
  {
    name: 'list_chats',
    description: 'List recent WhatsApp chats',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of chats to return (default: 20)' },
      },
    },
  },
  {
    name: 'get_messages',
    description: 'Get recent messages from a specific chat',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The chat ID to get messages from' },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return (default: 10)',
        },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'get_auth_status',
    description: 'Check WhatsApp connection status',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'show_qr_code',
    description: 'Display QR code for WhatsApp authentication (first-time setup)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_inbox',
    description:
      'Check for new incoming WhatsApp messages (user-initiated). Returns any messages received since last check.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

function openInBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(cmd, [url], (err) => {
    if (err) console.error('[WhatsApp Bridge] Failed to open browser:', err.message);
  });
}

export function buildMcpServer(whatsapp: WhatsAppManager, defaultRecipient?: string): Server {
  const mcpServer = new Server(
    { name: 'whatsapp-bridge', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS as unknown as object[] }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'send_message': {
          const { recipient, message } = args as { recipient: string; message: string };
          const target = recipient || defaultRecipient;
          if (!target) throw new Error('No recipient specified and no default recipient configured');
          const result = await whatsapp.sendMessage(target, message);
          return {
            content: [
              {
                type: 'text',
                text: `Message sent successfully.\n\nRecipient: ${target}\nMessage ID: ${result.messageId}\nTimestamp: ${new Date(result.timestamp).toISOString()}`,
              },
            ],
          };
        }

        case 'wait_for_reply': {
          const { chat_id, timeout_seconds } = args as { chat_id?: string; timeout_seconds?: number };
          const reply = await whatsapp.waitForReply(chat_id, (timeout_seconds || 300) * 1000);
          return { content: [{ type: 'text', text: `User replied:\n\n${reply}` }] };
        }

        case 'send_and_wait': {
          const { recipient, message, timeout_seconds } = args as {
            recipient: string;
            message: string;
            timeout_seconds?: number;
          };
          const target = recipient || defaultRecipient;
          if (!target) throw new Error('No recipient specified and no default recipient configured');
          const reply = await whatsapp.sendAndWait(target, message, (timeout_seconds || 300) * 1000);
          return {
            content: [{ type: 'text', text: `Message sent to ${target}.\n\nUser replied:\n\n${reply}` }],
          };
        }

        case 'list_chats': {
          const { limit } = args as { limit?: number };
          const chats = await whatsapp.listChats(limit || 20);
          if (chats.length === 0) {
            return {
              content: [
                { type: 'text', text: 'No chats found. Note: Chat history builds up as messages are sent/received.' },
              ],
            };
          }
          const chatList = chats
            .map((chat) => {
              const time = chat.lastMessageTime ? new Date(chat.lastMessageTime).toLocaleString() : 'N/A';
              return `- ${chat.name} (${chat.id})\n  Last activity: ${time}\n  Unread: ${chat.unreadCount}`;
            })
            .join('\n\n');
          return { content: [{ type: 'text', text: `Recent chats:\n\n${chatList}` }] };
        }

        case 'get_messages': {
          const { chat_id, limit } = args as { chat_id: string; limit?: number };
          const messages = await whatsapp.getMessages(chat_id, limit || 10);
          if (messages.length === 0) {
            return { content: [{ type: 'text', text: 'No messages found in this chat.' }] };
          }
          const messageList = messages
            .map((msg) => {
              const time = new Date(msg.timestamp).toLocaleString();
              const sender = msg.fromMe ? 'You' : msg.senderName || msg.sender;
              return `[${time}] ${sender}: ${msg.text}`;
            })
            .join('\n');
          return { content: [{ type: 'text', text: `Messages from ${chat_id}:\n\n${messageList}` }] };
        }

        case 'get_auth_status': {
          const status = whatsapp.getAuthStatus();
          let statusText = `Connection: ${status.connected ? 'Connected' : 'Disconnected'}`;
          if (status.phoneNumber) statusText += `\nPhone: +${status.phoneNumber}`;
          if (status.lastActivity) statusText += `\nLast activity: ${new Date(status.lastActivity).toLocaleString()}`;
          if (!status.connected) statusText += '\n\nUse show_qr_code to authenticate.';
          return { content: [{ type: 'text', text: statusText }] };
        }

        case 'show_qr_code': {
          if (!whatsapp.isConnected()) {
            try {
              await whatsapp.connect();
            } catch {
              // QR may still be available — continue.
            }
          }
          const result = await whatsapp.showQRCode();
          if (result.url) openInBrowser(result.url);
          return { content: [{ type: 'text', text: result.message }] };
        }

        case 'check_inbox': {
          const messages = whatsapp.checkInbox();
          if (messages.length === 0) {
            return { content: [{ type: 'text', text: 'No new messages.' }] };
          }
          const messageList = messages
            .map((msg) => {
              const time = new Date(msg.timestamp).toLocaleTimeString();
              const sender = msg.senderName || msg.sender.split('@')[0];
              return `[${time}] ${sender}: ${msg.text}`;
            })
            .join('\n');
          return { content: [{ type: 'text', text: `New messages:\n\n${messageList}` }] };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  return mcpServer;
}

export interface McpRouter {
  fetch(req: Request): Promise<Response>;
  activeSessionCount(): number;
  closeAll(): Promise<void>;
}

export function createMcpRouter(whatsapp: WhatsAppManager, defaultRecipient?: string): McpRouter {
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  const badRequest = (message: string): Response =>
    new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );

  return {
    activeSessionCount: () => transports.size,

    async closeAll() {
      const closes = [...transports.values()].map((t) => t.close().catch(() => undefined));
      transports.clear();
      await Promise.all(closes);
    },

    async fetch(req: Request): Promise<Response> {
      const sessionId = req.headers.get('mcp-session-id') ?? undefined;

      if (sessionId && transports.has(sessionId)) {
        return transports.get(sessionId)!.handleRequest(req);
      }

      if (sessionId) {
        return badRequest(`Bad Request: unknown session ID '${sessionId}' — re-initialize`);
      }

      if (req.method !== 'POST') {
        return badRequest('Bad Request: missing Mcp-Session-Id header');
      }

      // No session id and POST — could be an `initialize`. Peek at the body.
      let parsedBody: unknown;
      try {
        parsedBody = await req.clone().json();
      } catch {
        return badRequest('Bad Request: invalid JSON body');
      }

      const isInit = Array.isArray(parsedBody)
        ? parsedBody.some(isInitializeRequest)
        : isInitializeRequest(parsedBody);

      if (!isInit) {
        return badRequest('Bad Request: missing Mcp-Session-Id header for non-initialize request');
      }

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      const server = buildMcpServer(whatsapp, defaultRecipient);
      await server.connect(transport);

      return transport.handleRequest(req, { parsedBody });
    },
  };
}

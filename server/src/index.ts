#!/usr/bin/env bun

/**
 * WhatsApp Bridge MCP Server
 *
 * Streamable-HTTP MCP server that lets multiple concurrent Claude Code sessions
 * share one WhatsApp Web session. WhatsApp protocol allows exactly one connection
 * per phone, so a single persistent bridge owns the session and fans out MCP
 * tool calls to all connected clients.
 */

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WhatsAppManager } from './whatsapp.js';

async function main() {
  // Get auth directory from environment
  const authDir = process.env.WHATSAPP_AUTH_DIR?.replace('~', process.env.HOME || '');
  const defaultRecipient = process.env.WHATSAPP_DEFAULT_RECIPIENT;

  console.error('[WhatsApp Bridge] Starting MCP server...');

  // Create WhatsApp manager
  const whatsapp = new WhatsAppManager(authDir);

  // Create MCP server FIRST (don't block on WhatsApp connection)
  const mcpServer = new Server(
    { name: 'whatsapp-bridge', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
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
              message: {
                type: 'string',
                description: 'The message to send',
              },
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
          description: 'Send a message and wait for the user\'s reply in one step',
          inputSchema: {
            type: 'object',
            properties: {
              recipient: {
                type: 'string',
                description: 'Phone number (with country code) or WhatsApp JID',
              },
              message: {
                type: 'string',
                description: 'The message to send',
              },
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
              limit: {
                type: 'number',
                description: 'Maximum number of chats to return (default: 20)',
              },
            },
          },
        },
        {
          name: 'get_messages',
          description: 'Get recent messages from a specific chat',
          inputSchema: {
            type: 'object',
            properties: {
              chat_id: {
                type: 'string',
                description: 'The chat ID to get messages from',
              },
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
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'show_qr_code',
          description: 'Display QR code for WhatsApp authentication (first-time setup)',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'check_inbox',
          description: 'Check for new incoming WhatsApp messages (user-initiated). Returns any messages received since last check.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    };
  });

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'send_message': {
          const { recipient, message } = args as { recipient: string; message: string };
          const targetRecipient = recipient || defaultRecipient;

          if (!targetRecipient) {
            throw new Error('No recipient specified and no default recipient configured');
          }

          const result = await whatsapp.sendMessage(targetRecipient, message);
          return {
            content: [{
              type: 'text',
              text: `Message sent successfully.\n\nRecipient: ${targetRecipient}\nMessage ID: ${result.messageId}\nTimestamp: ${new Date(result.timestamp).toISOString()}`,
            }],
          };
        }

        case 'wait_for_reply': {
          const { chat_id, timeout_seconds } = args as { chat_id?: string; timeout_seconds?: number };
          const timeoutMs = (timeout_seconds || 300) * 1000;

          const reply = await whatsapp.waitForReply(chat_id, timeoutMs);
          return {
            content: [{
              type: 'text',
              text: `User replied:\n\n${reply}`,
            }],
          };
        }

        case 'send_and_wait': {
          const { recipient, message, timeout_seconds } = args as {
            recipient: string;
            message: string;
            timeout_seconds?: number;
          };
          const targetRecipient = recipient || defaultRecipient;
          const timeoutMs = (timeout_seconds || 300) * 1000;

          if (!targetRecipient) {
            throw new Error('No recipient specified and no default recipient configured');
          }

          const reply = await whatsapp.sendAndWait(targetRecipient, message, timeoutMs);
          return {
            content: [{
              type: 'text',
              text: `Message sent to ${targetRecipient}.\n\nUser replied:\n\n${reply}`,
            }],
          };
        }

        case 'list_chats': {
          const { limit } = args as { limit?: number };
          const chats = await whatsapp.listChats(limit || 20);

          if (chats.length === 0) {
            return {
              content: [{
                type: 'text',
                text: 'No chats found. Note: Chat history builds up as messages are sent/received.',
              }],
            };
          }

          const chatList = chats.map(chat => {
            const time = chat.lastMessageTime
              ? new Date(chat.lastMessageTime).toLocaleString()
              : 'N/A';
            return `- ${chat.name} (${chat.id})\n  Last activity: ${time}\n  Unread: ${chat.unreadCount}`;
          }).join('\n\n');

          return {
            content: [{
              type: 'text',
              text: `Recent chats:\n\n${chatList}`,
            }],
          };
        }

        case 'get_messages': {
          const { chat_id, limit } = args as { chat_id: string; limit?: number };
          const messages = await whatsapp.getMessages(chat_id, limit || 10);

          if (messages.length === 0) {
            return {
              content: [{
                type: 'text',
                text: 'No messages found in this chat.',
              }],
            };
          }

          const messageList = messages.map(msg => {
            const time = new Date(msg.timestamp).toLocaleString();
            const sender = msg.fromMe ? 'You' : (msg.senderName || msg.sender);
            return `[${time}] ${sender}: ${msg.text}`;
          }).join('\n');

          return {
            content: [{
              type: 'text',
              text: `Messages from ${chat_id}:\n\n${messageList}`,
            }],
          };
        }

        case 'get_auth_status': {
          const status = whatsapp.getAuthStatus();

          let statusText = `Connection: ${status.connected ? 'Connected' : 'Disconnected'}`;
          if (status.phoneNumber) {
            statusText += `\nPhone: +${status.phoneNumber}`;
          }
          if (status.lastActivity) {
            statusText += `\nLast activity: ${new Date(status.lastActivity).toLocaleString()}`;
          }
          if (!status.connected) {
            statusText += '\n\nUse show_qr_code to authenticate.';
          }

          return {
            content: [{ type: 'text', text: statusText }],
          };
        }

        case 'show_qr_code': {
          // Try reconnecting if not connected
          if (!whatsapp.isConnected()) {
            try {
              await whatsapp.connect();
            } catch (e) {
              // Continue anyway - QR might still be available
            }
          }

          const result = await whatsapp.showQRCode();

          if (result.url) {
            // Try to open browser
            const { exec } = await import('child_process');
            const openCmd = process.platform === 'darwin' ? 'open' :
                           process.platform === 'win32' ? 'start' : 'xdg-open';
            exec(`${openCmd} ${result.url}`);
          }

          return {
            content: [{
              type: 'text',
              text: result.message,
            }],
          };
        }

        case 'check_inbox': {
          const messages = whatsapp.checkInbox();

          if (messages.length === 0) {
            return {
              content: [{
                type: 'text',
                text: 'No new messages.',
              }],
            };
          }

          const messageList = messages.map(msg => {
            const time = new Date(msg.timestamp).toLocaleTimeString();
            const sender = msg.senderName || msg.sender.split('@')[0];
            return `[${time}] ${sender}: ${msg.text}`;
          }).join('\n');

          return {
            content: [{
              type: 'text',
              text: `New messages:\n\n${messageList}`,
            }],
          };
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

  // Connect MCP server via streamable HTTP (one shared transport, many clients)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcpServer.connect(transport);

  const host = process.env.WHATSAPP_MCP_HOST ?? '127.0.0.1';
  const port = parseInt(process.env.WHATSAPP_MCP_PORT ?? '8014', 10);

  Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/mcp') {
        return transport.handleRequest(req);
      }
      if (url.pathname === '/healthz') {
        const status = whatsapp.getAuthStatus();
        return Response.json({ ok: true, whatsapp: status });
      }
      return new Response('Not found', { status: 404 });
    },
  });

  console.error(`[WhatsApp Bridge] MCP HTTP server listening on http://${host}:${port}/mcp`);

  // Start WhatsApp connection in background (don't block MCP)
  whatsapp.connect().then(() => {
    const status = whatsapp.getAuthStatus();
    if (status.connected) {
      console.error(`[WhatsApp Bridge] Connected as +${status.phoneNumber}`);
    } else {
      console.error('[WhatsApp Bridge] Use show_qr_code tool to authenticate');
    }
  }).catch((error) => {
    console.error('[WhatsApp Bridge] Connection pending - use show_qr_code to authenticate');
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error('\n[WhatsApp Bridge] Shutting down...');
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

/**
 * WhatsApp Manager - Baileys integration for WhatsApp Web
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type ConnectionState,
  type WAMessage,
  type BaileysEventMap,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createServer, type Server } from 'http';

export interface Chat {
  id: string;
  name: string;
  lastMessage?: string;
  lastMessageTime?: number;
  unreadCount: number;
}

export interface Message {
  id: string;
  chatId: string;
  sender: string;
  senderName?: string;
  text: string;
  timestamp: number;
  fromMe: boolean;
}

export interface AuthStatus {
  connected: boolean;
  phoneNumber?: string;
  lastActivity?: number;
}

interface PendingReply {
  chatId: string;
  resolve: (message: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// Simple logger that suppresses Baileys noise
const silentLogger = {
  level: 'silent' as const,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

export class WhatsAppManager {
  private sock: WASocket | null = null;
  private authDir: string;
  private pendingReplies = new Map<string, PendingReply>();
  private currentQR: string | null = null;
  private connected = false;
  private phoneNumber: string | null = null;
  private lastActivity: number | null = null;
  private lastSentChatId: string | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private recentChats = new Map<string, { name: string; lastTime: number }>();
  private recentMessages: Message[] = [];
  private maxStoredMessages = 100;
  private qrServer: Server | null = null;
  private qrServerPort = 3456;
  private sentMessageIds = new Set<string>(); // Track messages we sent via MCP
  private lastCheckedTimestamp = 0; // For check_inbox tracking
  private inboxMessages: Message[] = []; // Unread messages queue

  constructor(authDir?: string) {
    const defaultDir = join(homedir(), '.whatsapp-bridge');
    this.authDir = authDir?.replace('~', homedir()) || defaultDir;
  }

  async connect(): Promise<void> {
    // Ensure auth directory exists
    if (!existsSync(this.authDir)) {
      await mkdir(this.authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger as any),
      },
      version,
      logger: silentLogger as any,
      printQRInTerminal: false,
      browser: ['WhatsApp Bridge', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    // Handle connection updates
    this.sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      this.handleConnectionUpdate(update);
    });

    // Save credentials on update
    this.sock.ev.on('creds.update', saveCreds);

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', (m: BaileysEventMap['messages.upsert']) => {
      this.handleMessagesUpsert(m);
    });

    // Wait for connection or QR code
    await this.waitForConnection(30000);
  }

  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.currentQR = qr;
      console.error('[WhatsApp] QR code available - use show_qr_code tool to display');
    }

    if (connection === 'close') {
      this.connected = false;
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.error(`[WhatsApp] Connection closed. Status: ${statusCode}`);

      if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        console.error(`[WhatsApp] Reconnecting... (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), 3000);
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.error('[WhatsApp] Logged out - need to scan QR code again');
      }
    }

    if (connection === 'open') {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.currentQR = null;
      this.lastActivity = Date.now();
      this.stopQRServer(); // Stop QR server once connected

      // Get phone number from socket
      const user = this.sock?.user;
      if (user) {
        this.phoneNumber = user.id.split(':')[0];
        console.error(`[WhatsApp] Connected as +${this.phoneNumber}`);
      }

      // Pre-load all groups so community sub-groups appear in listChats
      this.loadAllGroups();
    }
  }

  private async loadAllGroups(): Promise<void> {
    if (!this.sock) return;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups)) {
        if (!this.recentChats.has(jid)) {
          this.recentChats.set(jid, {
            name: meta.subject || jid.split('@')[0],
            lastTime: meta.subjectTime ? meta.subjectTime * 1000 : 0,
          });
        }
      }
      console.error(`[WhatsApp] Loaded ${Object.keys(groups).length} groups`);
    } catch (e) {
      console.error('[WhatsApp] Failed to load groups:', e);
    }
  }

  private async handleMessagesUpsert(m: BaileysEventMap['messages.upsert']): Promise<void> {
    const { messages, type } = m;

    for (const msg of messages) {
      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      // Store chat info
      const pushName = msg.pushName || chatId.split('@')[0];
      // For groups, resolve the group subject instead of using sender's pushName
      if (chatId.endsWith('@g.us') && this.sock) {
        try {
          const existing = this.recentChats.get(chatId);
          if (!existing || existing.name === pushName || existing.name === chatId.split('@')[0]) {
            const meta = await this.sock!.groupMetadata(chatId);
            this.recentChats.set(chatId, {
              name: meta.subject || pushName,
              lastTime: Date.now(),
            });
          } else {
            this.recentChats.set(chatId, { name: existing.name, lastTime: Date.now() });
          }
        } catch {
          this.recentChats.set(chatId, { name: pushName, lastTime: Date.now() });
        }
      } else {
        this.recentChats.set(chatId, { name: pushName, lastTime: Date.now() });
      }

      // Skip non-notify messages for reply handling
      if (type !== 'notify') continue;

      this.lastActivity = Date.now();

      const text = this.extractMessageText(msg);
      if (!text) continue;

      // Store message
      const storedMsg: Message = {
        id: msg.key.id || 'unknown',
        chatId,
        sender: msg.key.participant || chatId,
        senderName: msg.pushName,
        text,
        timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
        fromMe: msg.key.fromMe || false,
      };

      this.recentMessages.push(storedMsg);
      if (this.recentMessages.length > this.maxStoredMessages) {
        this.recentMessages.shift();
      }

      // Skip messages that WE sent via this MCP server (not phone replies)
      const msgId = msg.key.id || '';
      if (this.sentMessageIds.has(msgId)) {
        this.sentMessageIds.delete(msgId); // Clean up
        continue;
      }

      // Add to inbox for check_inbox tool
      this.inboxMessages.push(storedMsg);

      // Write to pending file for hook notification
      this.writePendingFile(storedMsg);

      // Check for pending reply - always use wildcard since JID formats vary
      const pending = this.pendingReplies.get('__any__');
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingReplies.delete('__any__');
        pending.resolve(text);
        continue;
      }
    }
  }

  checkInbox(): Message[] {
    // Return and clear all unread messages
    const messages = [...this.inboxMessages];
    this.inboxMessages = [];
    // Clear the pending file since we've read them
    this.clearPendingFile();
    return messages;
  }

  private async writePendingFile(msg: Message): Promise<void> {
    try {
      const pendingPath = join(this.authDir, 'pending_messages.json');
      let pending: any[] = [];

      try {
        const existing = await readFile(pendingPath, 'utf-8');
        pending = JSON.parse(existing);
      } catch {
        // File doesn't exist or invalid JSON
      }

      pending.push({
        time: new Date(msg.timestamp).toLocaleTimeString(),
        sender: msg.senderName || msg.sender.split('@')[0],
        text: msg.text,
      });

      await writeFile(pendingPath, JSON.stringify(pending, null, 2));
    } catch (err) {
      console.error('[WhatsApp] Failed to write pending file:', err);
    }
  }

  private async clearPendingFile(): Promise<void> {
    try {
      const pendingPath = join(this.authDir, 'pending_messages.json');
      await writeFile(pendingPath, '[]');
    } catch {
      // Ignore
    }
  }

  private extractMessageText(msg: WAMessage): string | null {
    const content = msg.message;
    if (!content) return null;

    if (content.conversation) return content.conversation;
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
    if (content.imageMessage?.caption) return content.imageMessage.caption;
    if (content.videoMessage?.caption) return content.videoMessage.caption;
    if (content.documentMessage?.caption) return content.documentMessage.caption;

    return null;
  }

  private async waitForConnection(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.connected) return;
      if (this.currentQR) {
        // QR available but not scanned yet - that's okay, we'll wait
        console.error('[WhatsApp] Waiting for QR code scan...');
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (!this.connected && this.currentQR) {
      // Not connected but QR is available - acceptable state
      console.error('[WhatsApp] Ready for QR scan');
      return;
    }

    if (!this.connected) {
      throw new Error('WhatsApp connection timeout');
    }
  }

  async sendMessage(recipient: string, message: string): Promise<{ messageId: string; timestamp: number }> {
    if (!this.sock) throw new Error('WhatsApp not connected');
    if (!this.connected) throw new Error('WhatsApp not connected - use show_qr_code to authenticate');

    // Normalize phone number to JID format
    const jid = this.normalizeRecipient(recipient);

    const result = await this.sock.sendMessage(jid, { text: message });

    // Track this message ID so we don't capture it as a reply
    const messageId = result?.key.id || 'unknown';
    if (messageId !== 'unknown') {
      this.sentMessageIds.add(messageId);
    }

    this.lastSentChatId = jid;
    this.lastActivity = Date.now();

    return {
      messageId,
      timestamp: Date.now(),
    };
  }

  async waitForReply(chatId?: string, timeoutMs: number = 300000): Promise<string> {
    // Always use wildcard - WhatsApp uses different JID formats
    // (@s.whatsapp.net vs @lid) so we can't reliably match chat IDs
    const waitKey = '__any__';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReplies.delete(waitKey);
        reject(new Error(`Timeout waiting for reply after ${timeoutMs / 1000} seconds`));
      }, timeoutMs);

      this.pendingReplies.set(waitKey, {
        chatId: chatId || 'any',
        resolve,
        reject,
        timeout,
      });
    });
  }

  async sendAndWait(
    recipient: string,
    message: string,
    timeoutMs: number = 300000
  ): Promise<string> {
    await this.sendMessage(recipient, message);
    return this.waitForReply(recipient, timeoutMs);
  }

  async listChats(limit: number = 20): Promise<Chat[]> {
    const chats: Chat[] = [];

    const sorted = [...this.recentChats.entries()]
      .sort((a, b) => b[1].lastTime - a[1].lastTime)
      .slice(0, limit);

    for (const [id, info] of sorted) {
      let name = info.name;
      // Resolve group names that might still show sender pushName
      if (id.endsWith('@g.us') && this.sock) {
        try {
          const meta = await this.sock!.groupMetadata(id);
          if (meta.subject) name = meta.subject;
        } catch { /* keep existing name */ }
      }
      chats.push({
        id,
        name,
        lastMessageTime: info.lastTime,
        unreadCount: 0,
      });
    }

    return chats;
  }

  async getMessages(chatId: string, limit: number = 10): Promise<Message[]> {
    const jid = this.normalizeRecipient(chatId);

    return this.recentMessages
      .filter(msg => msg.chatId === jid)
      .slice(-limit);
  }

  getAuthStatus(): AuthStatus {
    return {
      connected: this.connected,
      phoneNumber: this.phoneNumber || undefined,
      lastActivity: this.lastActivity || undefined,
    };
  }

  async showQRCode(): Promise<{ url?: string; message: string }> {
    if (this.connected) {
      return { message: 'Already connected - no QR code needed' };
    }

    if (!this.currentQR) {
      return { message: 'No QR code available yet. Try again in a few seconds.' };
    }

    // Start HTTP server to display QR code
    await this.startQRServer();

    const url = `http://localhost:${this.qrServerPort}`;
    return {
      url,
      message: `QR code available at ${url} - open in browser and scan with WhatsApp`,
    };
  }

  private async startQRServer(): Promise<void> {
    if (this.qrServer) {
      return; // Already running
    }

    this.qrServer = createServer((req, res) => {
      if (this.connected) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>WhatsApp Bridge</title></head>
          <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:system-ui;background:#25D366;color:white;">
            <div style="text-align:center;">
              <h1>✓ Connected!</h1>
              <p>WhatsApp is now linked. You can close this page.</p>
            </div>
          </body>
          </html>
        `);
        return;
      }

      if (!this.currentQR) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>WhatsApp Bridge</title><meta http-equiv="refresh" content="2"></head>
          <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:system-ui;">
            <div style="text-align:center;">
              <h1>Waiting for QR code...</h1>
              <p>This page will refresh automatically.</p>
            </div>
          </body>
          </html>
        `);
        return;
      }

      // Generate QR code as SVG
      QRCode.toString(this.currentQR, { type: 'svg', width: 300 }, (err: Error | null, svg: string) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error generating QR code');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>WhatsApp Bridge - Scan QR</title>
            <meta http-equiv="refresh" content="10">
            <style>
              body {
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                font-family: system-ui;
                background: #f0f0f0;
                margin: 0;
              }
              .container {
                background: white;
                padding: 40px;
                border-radius: 16px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.1);
                text-align: center;
              }
              h1 { color: #25D366; margin-bottom: 10px; }
              .qr-code {
                padding: 20px;
                background: white;
              }
              .qr-code svg {
                width: 300px;
                height: 300px;
              }
              .instructions {
                margin-top: 20px;
                color: #666;
              }
              .instructions ol {
                text-align: left;
                display: inline-block;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>WhatsApp Bridge</h1>
              <p>Scan this QR code with WhatsApp</p>
              <div class="qr-code">${svg}</div>
              <div class="instructions">
                <ol>
                  <li>Open WhatsApp on your phone</li>
                  <li>Go to Settings → Linked Devices</li>
                  <li>Tap "Link a Device"</li>
                  <li>Scan this QR code</li>
                </ol>
              </div>
            </div>
          </body>
          </html>
        `);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.qrServer!.listen(this.qrServerPort, () => {
        console.error(`[WhatsApp] QR server running at http://localhost:${this.qrServerPort}`);
        resolve();
      });
      this.qrServer!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Port already in use, try next port
          this.qrServerPort++;
          this.qrServer = null;
          this.startQRServer().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });
    });
  }

  private stopQRServer(): void {
    if (this.qrServer) {
      this.qrServer.close();
      this.qrServer = null;
    }
  }

  private normalizeRecipient(recipient: string): string {
    // Already a JID
    if (recipient.includes('@')) return recipient;

    // Phone number - normalize and convert to JID
    const cleaned = recipient.replace(/[^0-9]/g, '');
    return `${cleaned}@s.whatsapp.net`;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
      this.connected = false;
    }
  }
}

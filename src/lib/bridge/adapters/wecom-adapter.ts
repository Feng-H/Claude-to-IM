/**
 * WeCom (企业微信) Adapter — implements BaseChannelAdapter for WeCom AI Bot API.
 *
 * Uses HTTP callback server for receiving messages and response_url for replying.
 * WeCom AI Bot (智能机器人) supports single chat (C2C) and group chat interactions.
 *
 * Message flow:
 * 1. WeCom server sends encrypted JSON callback to our HTTP endpoint
 * 2. We decrypt the message using AES-256-CBC
 * 3. Process the message and queue it for consumption
 * 4. Reply using the response_url provided in the callback
 */

import crypto from 'crypto';
import http from 'http';
import type {
  ChannelType,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';

/** Max number of message_ids to keep for dedup. */
const DEDUP_MAX = 1000;

/** Default callback server port. */
const DEFAULT_PORT = 3100;

/** Callback path for WeCom messages. */
const CALLBACK_PATH = '/wecom/callback';

// ── Types ──────────────────────────────────────────────────────

interface WeComConfig {
  botId: string;
  token: string;
  encodingAesKey: string;
  callbackPort: number;
}

interface WeComCallback {
  msgid: string;
  aibotid: string;
  chatid?: string;
  chattype: 'single' | 'group';
  from: { userid: string };
  response_url: string;
  msgtype: 'text' | 'image' | 'mixed' | 'voice' | 'file';
  text?: { content: string };
  image?: { url: string };
  mixed?: { msg_item: Array<{ msgtype: string; text?: { content: string }; image?: { url: string } }> };
  voice?: { content: string };
  file?: { url: string };
}

interface PendingResponse {
  responseUrl: string;
  expiresAt: number;
}

// ── AES Cryptography (WeCom style) ─────────────────────────────

/**
 * Decrypt WeCom encrypted message.
 * WeCom uses AES-256-CBC with PKCS#7 padding.
 * Key is base64-decoded EncodingAESKey (43 chars, decoded to 32 bytes).
 * IV is first 16 bytes of the key.
 */
function decryptWeComMessage(encryptedBase64: string, encodingAesKey: string): string {
  // EncodingAESKey is 43 chars, base64 decode to 32 bytes + 1 byte checksum
  const key = Buffer.from(encodingAesKey + '=', 'base64');
  const iv = key.slice(0, 16);

  const encrypted = Buffer.from(encryptedBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);

  let decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  // Remove PKCS#7 padding
  const pad = decrypted[decrypted.length - 1];
  decrypted = decrypted.slice(0, decrypted.length - pad);

  // WeCom format: random(16) + msg_len(4) + msg + receiveid
  // msg_len is network byte order (big-endian)
  const msgLen = decrypted.readUInt32BE(16);
  const msg = decrypted.slice(20, 20 + msgLen).toString('utf8');

  return msg;
}

/**
 * Compute signature for URL verification.
 */
function computeSignature(token: string, timestamp: string, nonce: string, echostr?: string): string {
  const arr = [token, timestamp, nonce];
  if (echostr) arr.push(echostr);
  arr.sort();
  const str = arr.join('');
  return crypto.createHash('sha1').update(str).digest('hex');
}

// ── WeCom Adapter ───────────────────────────────────────────────

export class WeComAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'wecom';

  private _running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private server: http.Server | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private config: WeComConfig | null = null;
  private pendingResponses = new Map<string, PendingResponse>();

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[wecom-adapter] Cannot start:', configError);
      return;
    }

    this.config = this.loadConfig();
    this._running = true;

    await this.startHttpServer();

    console.log('[wecom-adapter] Started, listening on port', this.config.callbackPort);
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Wake all waiters with null
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    this.queue = [];
    this.seenMessageIds.clear();
    this.pendingResponses.clear();

    console.log('[wecom-adapter] Stopped');
  }

  isRunning(): boolean {
    return this._running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (!this._running) return Promise.resolve(null);

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  // ── Send ────────────────────────────────────────────────────

  async send(message: OutboundMessage): Promise<SendResult> {
    // Look up pending response URL for this chat
    const pending = this.pendingResponses.get(message.address.chatId);
    if (!pending) {
      return { ok: false, error: 'No response_url available for this chat' };
    }

    if (Date.now() > pending.expiresAt) {
      this.pendingResponses.delete(message.address.chatId);
      return { ok: false, error: 'response_url expired (valid for 1 hour)' };
    }

    try {
      let content = message.text;
      if (message.parseMode === 'HTML') {
        // Convert HTML to Markdown for WeCom
        content = content.replace(/<br\s*\/?>/gi, '\n');
        content = content.replace(/<b>(.*?)<\/b>/gi, '**$1**');
        content = content.replace(/<i>(.*?)<\/i>/gi, '*$1*');
        content = content.replace(/<code>(.*?)<\/code>/gi, '`$1`');
        content = content.replace(/<pre>(.*?)<\/pre>/gis, '```\n$1\n```');
        content = content.replace(/<[^>]+>/g, ''); // Remove other HTML tags
      }

      const response = await fetch(pending.responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'markdown',
          markdown: { content },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: \`WeCom API error: \${response.status} \${text}\` };
      }

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Config & Auth ───────────────────────────────────────────

  private loadConfig(): WeComConfig {
    const store = getBridgeContext().store;
    return {
      botId: store.getSetting('bridge_wecom_bot_id') || '',
      token: store.getSetting('bridge_wecom_token') || '',
      encodingAesKey: store.getSetting('bridge_wecom_encoding_aes_key') || '',
      callbackPort: parseInt(store.getSetting('bridge_wecom_callback_port') || '', 10) || DEFAULT_PORT,
    };
  }

  validateConfig(): string | null {
    const config = this.loadConfig();
    if (!config.botId) return 'bridge_wecom_bot_id not configured';
    if (!config.token) return 'bridge_wecom_token not configured';
    if (!config.encodingAesKey) return 'bridge_wecom_encoding_aes_key not configured';
    if (config.encodingAesKey.length !== 43) {
      return 'bridge_wecom_encoding_aes_key must be 43 characters';
    }
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const allowedUsers = getBridgeContext().store.getSetting('bridge_wecom_allowed_users') || '';
    if (!allowedUsers) return true;

    const allowed = allowedUsers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (allowed.length === 0) return true;

    return allowed.includes(userId);
  }

  // ── HTTP Server ──────────────────────────────────────────────

  private async startHttpServer(): Promise<void> {
    const config = this.config!;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res).catch((err) => {
          console.error('[wecom-adapter] HTTP handler error:', err);
          res.statusCode = 500;
          res.end('Internal Server Error');
        });
      });

      this.server.on('error', (err) => {
        console.error('[wecom-adapter] HTTP server error:', err);
        if (!this._running) {
          reject(err);
        }
      });

      this.server.listen(config.callbackPort, () => {
        resolve();
      });
    });
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const config = this.config!;
    const url = new URL(req.url || '/', \`http://localhost:\${config.callbackPort}\`);

    // Only handle callback path
    if (!url.pathname.startsWith(CALLBACK_PATH)) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const query = url.searchParams;
    const signature = query.get('msg_signature') || '';
    const timestamp = query.get('timestamp') || '';
    const nonce = query.get('nonce') || '';

    // ── URL Verification (GET) ─────────────────────────────────
    if (req.method === 'GET') {
      const echostr = query.get('echostr');

      if (!echostr) {
        res.statusCode = 400;
        res.end('Missing echostr');
        return;
      }

      // Verify signature
      const expectedSig = computeSignature(config.token, timestamp, nonce, echostr);
      if (signature !== expectedSig) {
        console.warn('[wecom-adapter] URL verification signature mismatch');
        res.statusCode = 403;
        res.end('Signature verification failed');
        return;
      }

      // Decrypt echostr and return it
      try {
        const decrypted = decryptWeComMessage(echostr, config.encodingAesKey);
        console.log('[wecom-adapter] URL verification successful');
        res.statusCode = 200;
        res.end(decrypted);
        return;
      } catch (err) {
        console.error('[wecom-adapter] Failed to decrypt echostr:', err);
        res.statusCode = 500;
        res.end('Decryption failed');
        return;
      }
    }

    // ── Message Callback (POST) ─────────────────────────────────
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }

      // Verify signature (without body for POST)
      const expectedSig = computeSignature(config.token, timestamp, nonce);
      if (signature !== expectedSig) {
        console.warn('[wecom-adapter] POST signature mismatch');
        res.statusCode = 403;
        res.end('Signature verification failed');
        return;
      }

      // Parse encrypted JSON
      let encryptedData: { encrypt: string };
      try {
        encryptedData = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.end('Invalid JSON');
        return;
      }

      // Decrypt message
      let decryptedJson: string;
      try {
        decryptedJson = decryptWeComMessage(encryptedData.encrypt, config.encodingAesKey);
      } catch (err) {
        console.error('[wecom-adapter] Failed to decrypt message:', err);
        res.statusCode = 500;
        res.end('Decryption failed');
        return;
      }

      // Parse decrypted JSON
      let callback: WeComCallback;
      try {
        callback = JSON.parse(decryptedJson);
      } catch {
        console.error('[wecom-adapter] Failed to parse decrypted JSON:', decryptedJson);
        res.statusCode = 400;
        res.end('Invalid decrypted JSON');
        return;
      }

      // Process message
      this.handleCallback(callback);

      // Respond with success (empty response)
      res.statusCode = 200;
      res.end('');
      return;
    }

    // Method not allowed
    res.statusCode = 405;
    res.end('Method Not Allowed');
  }

  // ── Callback Handling ────────────────────────────────────────

  private handleCallback(callback: WeComCallback): void {
    // Dedup
    if (this.seenMessageIds.has(callback.msgid)) return;
    this.seenMessageIds.set(callback.msgid, true);

    // Evict oldest when exceeding limit
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(key);
        removed++;
      }
    }

    const userId = callback.from.userid;

    // Authorization check
    if (!this.isAuthorized(userId, callback.chatid || userId)) {
      console.warn('[wecom-adapter] Unauthorized message from:', userId);
      return;
    }

    // Store response_url for later use (valid for 1 hour)
    this.pendingResponses.set(callback.chatid || userId, {
      responseUrl: callback.response_url,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });

    // Extract text content
    let text = '';
    switch (callback.msgtype) {
      case 'text':
        text = callback.text?.content || '';
        break;
      case 'voice':
        text = callback.voice?.content || '[语音消息]';
        break;
      case 'mixed':
        text = callback.mixed?.msg_item
          .map((item) => item.text?.content || '[图片]')
          .join(' ') || '';
        break;
      case 'image':
        text = '[图片消息]';
        break;
      case 'file':
        text = '[文件消息]';
        break;
    }

    if (!text.trim()) return;

    const chatId = callback.chattype === 'group' && callback.chatid ? callback.chatid : userId;

    const inbound: InboundMessage = {
      messageId: callback.msgid,
      address: {
        channelType: 'wecom',
        chatId,
        userId,
        displayName: userId.slice(0, 8),
      },
      text: text.trim(),
      timestamp: Date.now(),
    };

    this.enqueue(inbound);

    // Audit log
    try {
      getBridgeContext().store.insertAuditLog({
        channelType: 'wecom',
        chatId,
        direction: 'inbound',
        messageId: callback.msgid,
        summary: text.slice(0, 200),
      });
    } catch { /* best effort */ }
  }
}

// Self-register so bridge-manager can create WeComAdapter via the registry.
registerAdapterFactory('wecom', () => new WeComAdapter());

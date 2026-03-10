/**
 * WeCom (企业微信) Adapter — implements BaseChannelAdapter for WeCom AI Bot API.
 *
 * Uses WebSocket long connection for receiving messages and replying.
 * This approach does NOT require a public IP or message encryption.
 *
 * Based on official @wecom/aibot-node-sdk pattern.
 *
 * Message flow:
 * 1. Connect to wss://openws.work.weixin.qq.com
 * 2. Subscribe with BotID + Secret
 * 3. Receive messages via aibot_msg_callback
 * 4. Reply via aibot_respond_msg (supports streaming)
 * 5. Keep alive with ping heartbeat
 */

import crypto from 'crypto';
import WebSocket from 'ws';
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

/** WebSocket gateway URL. */
const GATEWAY_URL = 'wss://openws.work.weixin.qq.com';

/** Heartbeat interval (30 seconds). */
const HEARTBEAT_INTERVAL = 30000;

/** Reconnect delay base (exponential backoff). */
const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000;

// ── Types ──────────────────────────────────────────────────────

interface WeComConfig {
  botId: string;
  secret: string;
}

interface WeComMessage {
  cmd: string;
  headers: {
    req_id: string;
  };
  body?: WeComCallbackBody;
  errcode?: number;
  errmsg?: string;
}

interface WeComCallbackBody {
  msgid: string;
  aibotid: string;
  chatid?: string;
  chattype: 'single' | 'group';
  from: { userid: string };
  msgtype: 'text' | 'image' | 'mixed' | 'voice' | 'file' | 'event';
  text?: { content: string };
  image?: { url: string; aeskey?: string };
  mixed?: { msg_item: Array<{ msgtype: string; text?: { content: string }; image?: { url: string } }> };
  voice?: { content: string };
  file?: { url: string; aeskey?: string };
  event?: { eventtype: string };
}

interface PendingRequest {
  chatId: string;
  reqId: string;
  expiresAt: number;
  streamId?: string;
}

// ── Helper Functions ────────────────────────────────────────────

function generateReqId(): string {
  return crypto.randomUUID();
}

function generateStreamId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

// ── WeCom Adapter ───────────────────────────────────────────────

export class WeComAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'wecom';

  private _running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private ws: WebSocket | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private config: WeComConfig | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = false;

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
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;

    await this.connect();

    console.log('[wecom-adapter] Started');
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    this.shouldReconnect = false;

    this.stopHeartbeat();

    if (this.ws) {
      try {
        this.ws.close(1000, 'adapter stopping');
      } catch { /* ignore */ }
      this.ws = null;
    }

    // Wake all waiters with null
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    this.queue = [];
    this.seenMessageIds.clear();
    this.pendingRequests.clear();

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
    const pending = this.pendingRequests.get(message.address.chatId);
    if (!pending) {
      return { ok: false, error: 'No pending request for this chat. User must send a message first.' };
    }

    if (Date.now() > pending.expiresAt) {
      this.pendingRequests.delete(message.address.chatId);
      return { ok: false, error: 'Request expired (24h limit for replies)' };
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { ok: false, error: 'WebSocket not connected' };
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
        content = content.replace(/<[^>]+>/g, '');
      }

      // Use streaming message for better UX
      const streamId = pending.streamId || generateStreamId();
      pending.streamId = streamId;

      const msg: WeComMessage = {
        cmd: 'aibot_respond_msg',
        headers: { req_id: pending.reqId },
        body: {
          msgtype: 'stream',
          stream: {
            id: streamId,
            finish: true,
            content,
          },
        },
      };

      this.ws.send(JSON.stringify(msg));
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
      secret: store.getSetting('bridge_wecom_secret') || '',
    };
  }

  validateConfig(): string | null {
    const config = this.loadConfig();
    if (!config.botId) return 'bridge_wecom_bot_id not configured';
    if (!config.secret) return 'bridge_wecom_secret not configured';
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

  // ── WebSocket Connection ──────────────────────────────────────

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(GATEWAY_URL);
      this.ws = ws;
      let resolved = false;

      ws.on('open', () => {
        console.log('[wecom-adapter] WebSocket connected, sending subscribe...');
        this.subscribe();
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WeComMessage;
          this.handleMessage(msg);

          // Resolve on successful subscribe
          if (msg.cmd === 'aibot_subscribe' && msg.errcode === 0 && !resolved) {
            resolved = true;
            this.reconnectAttempts = 0;
            this.startHeartbeat();
            resolve();
          }
        } catch (err) {
          console.error('[wecom-adapter] Failed to parse message:', err);
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`[wecom-adapter] WebSocket closed: code=${code}, reason=${reason.toString()}`);
        this.stopHeartbeat();

        if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket closed before subscribe: code=${code}`));
          return;
        }

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        console.error('[wecom-adapter] WebSocket error:', err.message);
      });
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg: WeComMessage = {
      cmd: 'aibot_subscribe',
      headers: { req_id: generateReqId() },
      body: {
        bot_id: this.config!.botId,
        secret: this.config!.secret,
      },
    };

    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(msg: WeComMessage): void {
    switch (msg.cmd) {
      case 'aibot_subscribe':
        if (msg.errcode === 0) {
          console.log('[wecom-adapter] Subscribed successfully');
        } else {
          console.error('[wecom-adapter] Subscribe failed:', msg.errmsg);
        }
        break;

      case 'aibot_msg_callback':
        this.handleMsgCallback(msg);
        break;

      case 'aibot_event_callback':
        this.handleEventCallback(msg);
        break;

      case 'pong':
        // Heartbeat response
        break;
    }
  }

  // ── Message Callback ──────────────────────────────────────────

  private handleMsgCallback(msg: WeComMessage): void {
    const body = msg.body;
    if (!body) return;

    // Dedup
    if (this.seenMessageIds.has(body.msgid)) return;
    this.seenMessageIds.set(body.msgid, true);

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

    const userId = body.from.userid;

    // Authorization check
    if (!this.isAuthorized(userId, body.chatid || userId)) {
      console.warn('[wecom-adapter] Unauthorized message from:', userId);
      return;
    }

    const chatId = body.chattype === 'group' && body.chatid ? body.chatid : userId;

    // Store pending request for reply (valid for 24h)
    this.pendingRequests.set(chatId, {
      chatId,
      reqId: msg.headers.req_id,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    // Extract text content
    let text = '';
    switch (body.msgtype) {
      case 'text':
        text = body.text?.content || '';
        break;
      case 'voice':
        text = body.voice?.content || '[语音消息]';
        break;
      case 'mixed':
        text = body.mixed?.msg_item
          .map((item) => item.text?.content || '[图片]')
          .join(' ') || '';
        break;
      case 'image':
        text = '[图片消息]';
        break;
      case 'file':
        text = '[文件消息]';
        break;
      default:
        return;
    }

    if (!text.trim()) return;

    const inbound: InboundMessage = {
      messageId: body.msgid,
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
        messageId: body.msgid,
        summary: text.slice(0, 200),
      });
    } catch { /* best effort */ }
  }

  // ── Event Callback ────────────────────────────────────────────

  private handleEventCallback(msg: WeComMessage): void {
    const body = msg.body;
    if (!body || body.msgtype !== 'event') return;

    const event = body.event?.eventtype;
    console.log('[wecom-adapter] Event:', event);

    switch (event) {
      case 'enter_chat':
        // User entered chat - could send welcome message
        const userId = body.from.userid;
        if (this.isAuthorized(userId, '')) {
          this.sendWelcomeMessage(msg.headers.req_id);
        }
        break;

      case 'disconnected_event':
        // Another connection took over
        console.warn('[wecom-adapter] Disconnected by another connection');
        this._running = false;
        break;
    }
  }

  private sendWelcomeMessage(reqId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg: WeComMessage = {
      cmd: 'aibot_respond_welcome_msg',
      headers: { req_id: reqId },
      body: {
        msgtype: 'text',
        text: { content: '你好！我是 AI 编程助手，有什么可以帮你的吗？' },
      },
    };

    this.ws.send(JSON.stringify(msg));
  }

  // ── Heartbeat ────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const msg: WeComMessage = {
          cmd: 'ping',
          headers: { req_id: generateReqId() },
        };
        this.ws.send(JSON.stringify(msg));
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Reconnection ──────────────────────────────────────────────

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY
    );

    console.log(`[wecom-adapter] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(async () => {
      if (!this.shouldReconnect) return;

      try {
        await this.connect();
        console.log('[wecom-adapter] Reconnected successfully');
      } catch (err) {
        console.error('[wecom-adapter] Reconnect failed:', err);
        this.scheduleReconnect();
      }
    }, delay);
  }
}

// Self-register so bridge-manager can create WeComAdapter via the registry.
registerAdapterFactory('wecom', () => new WeComAdapter());

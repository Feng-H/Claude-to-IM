/**
 * WeCom (企业微信) Adapter — implements BaseChannelAdapter for WeCom AI Bot API.
 *
 * Uses WebSocket long connection for receiving messages and replying.
 * This approach does NOT require a public IP or message encryption.
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

const DEDUP_MAX = 1000;
const GATEWAY_URL = 'wss://openws.work.weixin.qq.com';
const HEARTBEAT_INTERVAL = 30000;
const RECONNECT_BASE_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000;

// ── Types ──────────────────────────────────────────────────────

interface WeComConfig {
  botId: string;
  secret: string;
}

// Message FROM WeCom server (callback)
interface WeComCallbackBody {
  msgid: string;
  aibotid: string;
  chatid?: string;
  chattype: 'single' | 'group';
  from: { userid: string };
  msgtype: 'text' | 'image' | 'mixed' | 'voice' | 'file' | 'event' | 'stream';
  text?: { content: string };
  image?: { url: string; aeskey?: string };
  mixed?: { msg_item: Array<{ msgtype: string; text?: { content: string }; image?: { url: string } }> };
  voice?: { content: string };
  file?: { url: string; aeskey?: string };
  event?: { eventtype: string };
}

// Message FROM WeCom server (envelope)
interface WeComServerMessage {
  cmd?: string;
  headers: { req_id: string };
  body?: WeComCallbackBody;
  errcode?: number;
  errmsg?: string;
}

// Message TO WeCom server
interface WeComClientMessage {
  cmd: string;
  headers: { req_id: string };
  body?: Record<string, unknown>;
}

interface PendingRequest {
  chatId: string;
  reqId: string;
  expiresAt: number;
  streamId?: string;
}

interface PendingSubscribe {
  reqId: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

// ── Helpers ────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
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
  private pendingSubscribes = new Map<string, PendingSubscribe>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = false;

  async start(): Promise<void> {
    if (this._running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[wecom-adapter] Cannot start:', configError);
      return;
    }

    this.config = this.loadConfig();
    console.log('[wecom-adapter] Config loaded');
    this._running = true;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;

    await this.connect();
    console.log('[wecom-adapter] Started successfully');
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    this.shouldReconnect = false;

    this.stopHeartbeat();

    if (this.ws) {
      try { this.ws.close(1000, 'stopping'); } catch {}
      this.ws = null;
    }

    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
    this.queue = [];
    this.seenMessageIds.clear();
    this.pendingRequests.clear();
    this.pendingSubscribes.clear();

    console.log('[wecom-adapter] Stopped');
  }

  isRunning(): boolean {
    return this._running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this._running) return Promise.resolve(null);
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(msg);
    else this.queue.push(msg);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const pending = this.pendingRequests.get(message.address.chatId);
    if (!pending) {
      return { ok: false, error: 'No pending request for this chat' };
    }
    if (Date.now() > pending.expiresAt) {
      this.pendingRequests.delete(message.address.chatId);
      return { ok: false, error: 'Request expired' };
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { ok: false, error: 'WebSocket not connected' };
    }

    try {
      let content = message.text;
      if (message.parseMode === 'HTML') {
        content = content.replace(/<br\s*\/?>/gi, '\n');
        content = content.replace(/<b>(.*?)<\/b>/gi, '**$1**');
        content = content.replace(/<i>(.*?)<\/i>/gi, '*$1*');
        content = content.replace(/<code>(.*?)<\/code>/gi, '`$1`');
        content = content.replace(/<pre>(.*?)<\/pre>/gis, '```\n$1\n```');
        content = content.replace(/<[^>]+>/g, '');
      }

      const streamId = pending.streamId || uuid().replace(/-/g, '');
      pending.streamId = streamId;

      const msg: WeComClientMessage = {
        cmd: 'aibot_respond_msg',
        headers: { req_id: pending.reqId },
        body: {
          msgtype: 'stream',
          stream: { id: streamId, finish: true, content },
        },
      };

      this.ws.send(JSON.stringify(msg));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

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
    const allowed = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length === 0) return true;
    return allowed.includes(userId);
  }

  // ── WebSocket ────────────────────────────────────────────────

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('[wecom-adapter] Connecting to', GATEWAY_URL);
      const ws = new WebSocket(GATEWAY_URL);
      this.ws = ws;
      let resolved = false;

      ws.on('open', () => {
        console.log('[wecom-adapter] WebSocket connected, subscribing...');
        this.subscribe()
          .then(() => {
            if (!resolved) {
              resolved = true;
              this.reconnectAttempts = 0;
              this.startHeartbeat();
              resolve();
            }
          })
          .catch((err) => {
            if (!resolved) {
              resolved = true;
              reject(err);
            }
          });
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WeComServerMessage;
          this.handleMessage(msg);
        } catch (err) {
          console.error('[wecom-adapter] Parse error:', err);
        }
      });

      ws.on('close', (code, reason) => {
        console.log('[wecom-adapter] Closed:', code, reason.toString());
        this.stopHeartbeat();
        if (!resolved) {
          resolved = true;
          reject(new Error('Closed before subscribe: ' + code));
          return;
        }
        if (this.shouldReconnect) this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        console.error('[wecom-adapter] WebSocket error:', err.message);
      });
    });
  }

  private subscribe(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not open'));
        return;
      }
      const reqId = uuid();
      const msg: WeComClientMessage = {
        cmd: 'aibot_subscribe',
        headers: { req_id: reqId },
        body: { bot_id: this.config!.botId, secret: this.config!.secret },
      };
      
      this.pendingSubscribes.set(reqId, { reqId, resolve, reject });
      console.log('[wecom-adapter] Sending subscribe request...');
      this.ws.send(JSON.stringify(msg));
      
      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pendingSubscribes.has(reqId)) {
          this.pendingSubscribes.delete(reqId);
          reject(new Error('Subscribe timeout'));
        }
      }, 10000);
    });
  }

  private handleMessage(msg: WeComServerMessage): void {
    const reqId = msg.headers?.req_id;
    
    // Check if this is a subscribe response
    const pendingSub = this.pendingSubscribes.get(reqId);
    if (pendingSub) {
      this.pendingSubscribes.delete(reqId);
      if (msg.errcode === 0) {
        console.log('[wecom-adapter] Subscribe successful');
        pendingSub.resolve();
      } else {
        console.error('[wecom-adapter] Subscribe failed:', msg.errcode, msg.errmsg);
        pendingSub.reject(new Error('Subscribe failed: ' + (msg.errmsg || msg.errcode)));
      }
      return;
    }

    // Handle other messages
    const cmd = msg.cmd || '';
    switch (cmd) {
      case 'aibot_msg_callback':
        this.handleMsgCallback(msg);
        break;
      case 'aibot_event_callback':
        this.handleEventCallback(msg);
        break;
      case 'pong':
      case 'ping':
        // Heartbeat response, ignore
        break;
      default:
        if (msg.errcode !== undefined && msg.errcode !== 0) {
          console.warn('[wecom-adapter] Error response:', msg.errcode, msg.errmsg);
        }
    }
  }

  private handleMsgCallback(msg: WeComServerMessage): void {
    const body = msg.body;
    if (!body) return;

    if (this.seenMessageIds.has(body.msgid)) return;
    this.seenMessageIds.set(body.msgid, true);

    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed++ >= excess) break;
        this.seenMessageIds.delete(key);
      }
    }

    const userId = body.from.userid;
    if (!this.isAuthorized(userId, body.chatid || userId)) {
      console.warn('[wecom-adapter] Unauthorized:', userId);
      return;
    }

    const chatId = body.chattype === 'group' && body.chatid ? body.chatid : userId;
    this.pendingRequests.set(chatId, {
      chatId,
      reqId: msg.headers.req_id,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    let text = '';
    switch (body.msgtype) {
      case 'text': text = body.text?.content || ''; break;
      case 'voice': text = body.voice?.content || '[语音]'; break;
      case 'mixed':
        text = body.mixed?.msg_item.map(i => i.text?.content || '[图]').join(' ') || '';
        break;
      case 'image': text = '[图片]'; break;
      case 'file': text = '[文件]'; break;
      default: return;
    }

    if (!text.trim()) return;

    console.log('[wecom-adapter] Received message from', userId, ':', text.slice(0, 50));
    
    this.enqueue({
      messageId: body.msgid,
      address: { channelType: 'wecom', chatId, userId, displayName: userId.slice(0, 8) },
      text: text.trim(),
      timestamp: Date.now(),
    });

    try {
      getBridgeContext().store.insertAuditLog({
        channelType: 'wecom', chatId, direction: 'inbound',
        messageId: body.msgid, summary: text.slice(0, 200),
      });
    } catch {}
  }

  private handleEventCallback(msg: WeComServerMessage): void {
    const body = msg.body;
    if (!body || body.msgtype !== 'event') return;

    const event = body.event?.eventtype;
    console.log('[wecom-adapter] Event:', event);

    if (event === 'enter_chat' && body.from) {
      const userId = body.from.userid;
      if (this.isAuthorized(userId, '')) {
        this.sendWelcome(msg.headers.req_id);
      }
    } else if (event === 'disconnected_event') {
      console.warn('[wecom-adapter] Disconnected by another connection');
      this._running = false;
    }
  }

  private sendWelcome(reqId: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: WeComClientMessage = {
      cmd: 'aibot_respond_welcome_msg',
      headers: { req_id: reqId },
      body: { msgtype: 'text', text: { content: '你好！我是 AI 编程助手，有什么可以帮你的吗？' } },
    };
    this.ws.send(JSON.stringify(msg));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const msg: WeComClientMessage = { cmd: 'ping', headers: { req_id: uuid() } };
        this.ws.send(JSON.stringify(msg));
      }
    }, HEARTBEAT_INTERVAL);
    console.log('[wecom-adapter] Heartbeat started (30s interval)');
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    this.reconnectAttempts++;
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    console.log('[wecom-adapter] Reconnecting in', delay, 'ms');
    setTimeout(async () => {
      if (!this.shouldReconnect) return;
      try {
        await this.connect();
        console.log('[wecom-adapter] Reconnected');
      } catch (err) {
        console.error('[wecom-adapter] Reconnect failed:', err);
        this.scheduleReconnect();
      }
    }, delay);
  }
}

registerAdapterFactory('wecom', () => new WeComAdapter());

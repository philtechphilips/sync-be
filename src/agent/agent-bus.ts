import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { config } from '../config/config.service';

const REGISTRY_TTL_SECONDS = 60;
const prefix = 'synq:agent';

/** Where a user's agent is connected, shared by all API instances. */
export interface AgentLocation {
  instanceId: string;
  socketId: string;
  version: string | null;
  connections: { name: string; type: string; database: string | null }[];
}

export type BusMessage =
  | {
      type: 'request';
      requestId: string;
      from: string;
      userId: string;
      event: string;
      payload: Record<string, unknown>;
      minVersion: string | null;
      timeoutMs: number;
    }
  | {
      type: 'response';
      requestId: string;
      ok: boolean;
      data?: unknown;
      status?: number;
      message?: string;
    }
  | { type: 'kick'; userId: string; socketId: string; message: string };

/** JSON that keeps Buffers (binary query parameters) intact. */
function encode(message: BusMessage) {
  return JSON.stringify(message, (_key, value: unknown) => {
    if (
      value &&
      typeof value === 'object' &&
      (value as any).type === 'Buffer' &&
      Array.isArray((value as any).data)
    ) {
      return {
        __buffer: Buffer.from((value as any).data as number[]).toString(
          'base64',
        ),
      };
    }
    return value;
  });
}
function decode(text: string): BusMessage {
  return JSON.parse(text, (_key, value: unknown) =>
    value &&
    typeof value === 'object' &&
    typeof (value as any).__buffer === 'string'
      ? Buffer.from((value as any).__buffer as string, 'base64')
      : value,
  ) as BusMessage;
}

/**
 * Connects API instances through Redis when REDIS_URL is set: a registry of
 * which instance holds each user's agent socket, and a channel per instance
 * for forwarding agent requests to it. Without Redis everything is local.
 */
@Injectable()
export class AgentBus implements OnModuleDestroy {
  readonly instanceId = randomUUID();
  private readonly logger = new Logger(AgentBus.name);
  private readonly pub: Redis | null;
  private readonly sub: Redis | null;
  private handler: ((message: BusMessage) => void) | null = null;
  private ready: Promise<void> | null = null;

  constructor() {
    const url = config.REDIS_URL;
    this.pub = url
      ? new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 })
      : null;
    this.sub = url ? new Redis(url, { lazyConnect: false }) : null;
    if (this.sub) {
      this.ready = this.sub
        .subscribe(this.channel(this.instanceId))
        .then(() => undefined);
      this.sub.on('message', (_channel, text) => {
        try {
          this.handler?.(decode(text));
        } catch (e) {
          this.logger.warn(`Bad bus message: ${(e as Error).message}`);
        }
      });
      for (const client of [this.pub!, this.sub]) {
        client.on('error', (e) => this.logger.warn(`Redis: ${e.message}`));
      }
    }
  }

  get enabled() {
    return this.pub !== null;
  }

  onMessage(handler: (message: BusMessage) => void) {
    this.handler = handler;
  }

  private channel(instanceId: string) {
    return `${prefix}:instance:${instanceId}`;
  }
  private key(userId: string) {
    return `${prefix}:location:${userId}`;
  }

  async publish(instanceId: string, message: BusMessage) {
    await this.ready;
    await this.pub?.publish(this.channel(instanceId), encode(message));
  }

  async setLocation(userId: string, location: AgentLocation) {
    await this.pub?.set(
      this.key(userId),
      JSON.stringify(location),
      'EX',
      REGISTRY_TTL_SECONDS,
    );
  }

  async getLocation(userId: string): Promise<AgentLocation | null> {
    const text = await this.pub?.get(this.key(userId));
    return text ? (JSON.parse(text) as AgentLocation) : null;
  }

  /** Removes the entry only if it still points at this socket. */
  async clearLocation(userId: string, socketId: string) {
    await this.pub?.eval(
      `local v = redis.call('GET', KEYS[1])
       if v and cjson.decode(v).socketId == ARGV[1] then return redis.call('DEL', KEYS[1]) end
       return 0`,
      1,
      this.key(userId),
      socketId,
    );
  }

  /** Redis client for other shared state (rate limits). */
  get client() {
    return this.pub;
  }

  async onModuleDestroy() {
    for (const client of [this.pub, this.sub]) {
      if (client) await client.quit().catch(() => undefined);
    }
  }
}

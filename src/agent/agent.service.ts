import {
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import {
  ConnectionTarget,
  PageResult,
  Row,
  RunResult,
  ScriptResult,
  Statement,
  TxHandle,
  ValueKind,
} from '../clusters/engine/types';
import { ClusterType } from '../clusters/entities/cluster.entity';
import { AgentBus, BusMessage } from './agent-bus';

/** First agent version that speaks the paged/script/transaction protocol. */
export const AGENT_V2_VERSION = '1.1.0';
/** First agent version that keeps connections (and their passwords) locally. */
export const AGENT_CONNECTIONS_VERSION = '1.2.0';

const RUN_TIMEOUT_MS = 2 * 60 * 1000;
const LONG_TIMEOUT_MS = 10 * 60 * 1000;
const STATEMENTS_PER_MESSAGE = 500;
const HEARTBEAT_MS = 20_000;

/** A connection saved on the agent with `synqdb-agent add` (never includes secrets). */
export interface AgentConnectionInfo {
  name: string;
  type: string;
  database: string | null;
}

interface AgentConnection {
  socket: Socket;
  version: string | null;
  connections: AgentConnectionInfo[];
}

interface PendingRequest {
  /** Socket id, or `bus:<instance>` for requests forwarded to another instance. */
  via: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface SendOptions {
  minVersion: string | null;
  timeoutMs: number;
}

export function sanitizeConnections(value: unknown): AgentConnectionInfo[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (c: any) => c && typeof c === 'object' && typeof c.name === 'string',
    )
    .slice(0, 200)
    .map((c: any) => ({
      name: String(c.name).slice(0, 64),
      type: String(c.type ?? '').slice(0, 16),
      database:
        typeof c.database === 'string' ? c.database.slice(0, 255) : null,
    }));
}

export function versionAtLeast(version: string | null, min: string): boolean {
  if (!version) return false;
  const a = version.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

function toHttpError(
  status: number | undefined,
  message: string | undefined,
): HttpException {
  return new HttpException(
    { statusCode: status ?? 500, message: message ?? 'Agent request failed.' },
    status ?? 500,
  );
}

/**
 * Talks to users' local agents. The socket for an agent lives on whichever
 * API instance it connected to; with Redis (AgentBus) requests are routed to
 * that instance, so any instance can serve any user.
 */
@Injectable()
export class AgentService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentService.name);
  private readonly agents = new Map<string, AgentConnection>(); // userId → local agent
  private readonly pending = new Map<string, PendingRequest>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly bus: AgentBus) {
    this.bus.onMessage((message) => void this.onBusMessage(message));
    this.heartbeat = setInterval(
      () => void this.refreshLocations(),
      HEARTBEAT_MS,
    );
    this.heartbeat.unref();
  }

  onModuleDestroy() {
    clearInterval(this.heartbeat);
  }

  // ─── Registration ────────────────────────────────────────────────────────

  private location(agent: AgentConnection) {
    return {
      instanceId: this.bus.instanceId,
      socketId: agent.socket.id,
      version: agent.version,
      connections: agent.connections,
    };
  }

  private async refreshLocations() {
    if (!this.bus.enabled) return;
    for (const [userId, agent] of this.agents) {
      await this.bus
        .setLocation(userId, this.location(agent))
        .catch(() => undefined);
    }
  }

  async registerAgent(
    userId: string,
    socket: Socket,
    version: string | null,
    connections: AgentConnectionInfo[] = [],
  ): Promise<void> {
    const kickMessage =
      'Another agent connected with this key. This agent was disconnected.';
    const existing = this.agents.get(userId);
    if (existing && existing.socket.id !== socket.id) {
      existing.socket.emit('auth_error', { message: kickMessage });
      existing.socket.disconnect(true);
    }
    const agent = { socket, version, connections };
    this.agents.set(userId, agent);
    if (this.bus.enabled) {
      const previous = await this.bus.getLocation(userId);
      if (previous && previous.instanceId !== this.bus.instanceId) {
        await this.bus.publish(previous.instanceId, {
          type: 'kick',
          userId,
          socketId: previous.socketId,
          message: kickMessage,
        });
      }
      await this.bus.setLocation(userId, this.location(agent));
    }
    this.logger.log(
      `Agent registered: userId=${userId} version=${version ?? 'legacy'}`,
    );
  }

  /** Called when a socket disconnects: fail its in-flight requests now. */
  async socketClosed(socketId: string, userId?: string): Promise<void> {
    for (const [requestId, p] of this.pending) {
      if (p.via === socketId) {
        clearTimeout(p.timer);
        this.pending.delete(requestId);
        p.reject(
          new ServiceUnavailableException('The local agent disconnected.'),
        );
      }
    }
    if (userId && this.agents.get(userId)?.socket.id === socketId) {
      this.agents.delete(userId);
      await this.bus.clearLocation(userId, socketId).catch(() => undefined);
      this.logger.log(`Agent deregistered: userId=${userId}`);
    }
  }

  private kickLocal(userId: string, message: string, socketId?: string) {
    const agent = this.agents.get(userId);
    if (!agent || (socketId && agent.socket.id !== socketId)) return;
    agent.socket.emit('auth_error', { message });
    agent.socket.disconnect(true);
    this.agents.delete(userId);
  }

  async deregisterByUserId(userId: string): Promise<void> {
    const message =
      'Agent key has been rotated. Please run `synqdb-agent login` again.';
    this.kickLocal(userId, message);
    const location = await this.bus.getLocation(userId).catch(() => null);
    if (location && location.instanceId !== this.bus.instanceId) {
      await this.bus.publish(location.instanceId, {
        type: 'kick',
        userId,
        socketId: location.socketId,
        message,
      });
    }
  }

  /** The agent re-sends its list when its config file changes. */
  async updateConnections(
    userId: string,
    socketId: string,
    connections: AgentConnectionInfo[],
  ) {
    const agent = this.agents.get(userId);
    if (agent?.socket.id !== socketId) return;
    agent.connections = connections;
    if (this.bus.enabled)
      await this.bus.setLocation(userId, this.location(agent));
  }

  // ─── Status (local or via the shared registry) ───────────────────────────

  async getStatus(userId: string) {
    const local = this.agents.get(userId);
    if (local?.socket.connected) {
      return {
        connected: true,
        version: local.version,
        connections: local.connections,
      };
    }
    const remote = this.bus.enabled
      ? await this.bus.getLocation(userId).catch(() => null)
      : null;
    return remote
      ? {
          connected: true,
          version: remote.version,
          connections: remote.connections,
        }
      : {
          connected: false,
          version: null,
          connections: [] as AgentConnectionInfo[],
        };
  }

  async isAgentConnected(userId: string) {
    return (await this.getStatus(userId)).connected;
  }

  // ─── Responses from agents ───────────────────────────────────────────────

  handleResult(
    socketId: string,
    data: { requestId?: string } & Record<string, unknown>,
  ) {
    const p = data?.requestId ? this.pending.get(data.requestId) : undefined;
    // Only the socket the request was sent to may answer it.
    if (!p || p.via !== socketId) return;
    clearTimeout(p.timer);
    this.pending.delete(data.requestId!);
    p.resolve(data);
  }

  handleError(
    socketId: string,
    data: { requestId?: string; message?: string },
  ) {
    const p = data?.requestId ? this.pending.get(data.requestId) : undefined;
    if (!p || p.via !== socketId) return;
    clearTimeout(p.timer);
    this.pending.delete(data.requestId!);
    p.reject(
      new BadRequestException(
        data.message || 'Query failed on the local agent.',
      ),
    );
  }

  // ─── Sending ─────────────────────────────────────────────────────────────

  private notConnected() {
    return new ServiceUnavailableException(
      'Local agent is not connected. Run `synqdb-agent` on the machine that can reach this database.',
    );
  }

  private checkVersion(version: string | null, minVersion: string | null) {
    if (minVersion && !versionAtLeast(version, minVersion)) {
      throw new BadRequestException(
        `This action needs synqdb-agent ${minVersion} or newer. Update it with: npm install -g synqdb-agent@latest`,
      );
    }
  }

  private waitFor<T>(requestId: string, via: string, timeoutMs: number) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new GatewayTimeoutException(
            `The local agent did not respond within ${Math.round(timeoutMs / 1000)}s.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(requestId, { via, resolve, reject, timer });
    });
  }

  /** Sends to an agent connected to this instance. */
  private sendLocal<T>(
    userId: string,
    event: string,
    payload: Record<string, unknown>,
    opts: SendOptions,
  ): Promise<T> {
    const agent = this.agents.get(userId);
    if (!agent?.socket.connected) throw this.notConnected();
    this.checkVersion(agent.version, opts.minVersion);
    const requestId = randomUUID();
    const result = this.waitFor<T>(requestId, agent.socket.id, opts.timeoutMs);
    agent.socket.emit(event, { requestId, ...payload });
    return result;
  }

  private async send<T>(
    userId: string,
    event: string,
    payload: Record<string, unknown>,
    opts: SendOptions,
  ): Promise<T> {
    if (this.agents.get(userId)?.socket.connected || !this.bus.enabled) {
      return this.sendLocal<T>(userId, event, payload, opts);
    }
    const location = await this.bus.getLocation(userId);
    if (!location) throw this.notConnected();
    this.checkVersion(location.version, opts.minVersion);
    const requestId = randomUUID();
    const result = this.waitFor<T>(
      requestId,
      `bus:${location.instanceId}`,
      opts.timeoutMs + 5_000,
    );
    await this.bus.publish(location.instanceId, {
      type: 'request',
      requestId,
      from: this.bus.instanceId,
      userId,
      event,
      payload,
      minVersion: opts.minVersion,
      timeoutMs: opts.timeoutMs,
    });
    return result;
  }

  private async onBusMessage(message: BusMessage) {
    if (message.type === 'kick') {
      this.kickLocal(message.userId, message.message, message.socketId);
      return;
    }
    if (message.type === 'response') {
      const p = this.pending.get(message.requestId);
      if (!p || !p.via.startsWith('bus:')) return;
      clearTimeout(p.timer);
      this.pending.delete(message.requestId);
      if (message.ok) p.resolve(message.data);
      else p.reject(toHttpError(message.status, message.message));
      return;
    }
    // A request forwarded by another instance for an agent connected here.
    const reply = (
      body: Omit<
        Extract<BusMessage, { type: 'response' }>,
        'type' | 'requestId'
      >,
    ) =>
      this.bus.publish(message.from, {
        type: 'response',
        requestId: message.requestId,
        ...body,
      });
    try {
      const data = await this.sendLocal(
        message.userId,
        message.event,
        message.payload,
        {
          minVersion: message.minVersion,
          timeoutMs: message.timeoutMs,
        },
      );
      await reply({ ok: true, data });
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 500;
      await reply({ ok: false, status, message: (error as Error).message });
    }
  }

  // ─── Query API used by the executor ──────────────────────────────────────

  /** Oldest agent able to serve this request. */
  private minVersionFor(t: ConnectionTarget, needsV2: boolean): string | null {
    if (t.agentConnection) return AGENT_CONNECTIONS_VERSION;
    if (needsV2 || t.type === ClusterType.SQLITE) return AGENT_V2_VERSION;
    return null;
  }

  /** Only the connection name when the agent holds the credentials. */
  private connectionPayload(t: ConnectionTarget) {
    if (t.agentConnection)
      return { type: t.type, connection: t.agentConnection };
    return {
      type: t.type,
      host: t.host,
      port: t.port,
      username: t.username,
      password: t.password,
      database: t.database,
      sslMode: t.sslMode,
    };
  }

  async run(
    t: ConnectionTarget,
    sql: string,
    params: unknown[] = [],
    kinds: (ValueKind | null)[] = [],
  ): Promise<RunResult> {
    const namedParams =
      t.type === ClusterType.MSSQL
        ? Object.fromEntries(params.map((v, i) => [`p${i + 1}`, v]))
        : undefined;
    const res = await this.send<{
      rows?: Row[];
      rowCount?: number;
      insertId?: unknown;
    }>(
      t.userId,
      'query',
      {
        ...this.connectionPayload(t),
        mode: 'run',
        sql,
        params,
        paramKinds: kinds,
        namedParams,
      },
      { minVersion: this.minVersionFor(t, false), timeoutMs: RUN_TIMEOUT_MS },
    );
    let rows = Array.isArray(res.rows) ? res.rows : [];
    let rowCount = Number(res.rowCount ?? rows.length);
    // Agents before 1.1.0 return MySQL write results as [ResultSetHeader].
    const header = rows.length === 1 ? rows[0] : null;
    if (
      header &&
      ['affectedRows', 'insertId', 'fieldCount', 'serverStatus'].every(
        (k) => k in header,
      )
    ) {
      rowCount = Number(header.affectedRows);
      rows = [];
    }
    return {
      rows,
      rowCount,
      insertId: (res.insertId as string | number) ?? null,
    };
  }

  async runScript(t: ConnectionTarget, sql: string): Promise<ScriptResult> {
    const res = await this.send<ScriptResult>(
      t.userId,
      'query',
      { ...this.connectionPayload(t), mode: 'script', sql },
      { minVersion: this.minVersionFor(t, true), timeoutMs: LONG_TIMEOUT_MS },
    );
    return { results: res.results ?? [], rowCounts: res.rowCounts ?? [] };
  }

  async runPage(
    t: ConnectionTarget,
    sql: string,
    offset: number,
    limit: number,
  ): Promise<PageResult> {
    const res = await this.send<PageResult>(
      t.userId,
      'query',
      { ...this.connectionPayload(t), mode: 'page', sql, offset, limit },
      { minVersion: this.minVersionFor(t, true), timeoutMs: LONG_TIMEOUT_MS },
    );
    return { rows: res.rows ?? [], total: Number(res.total ?? 0) };
  }

  async transaction<T>(
    t: ConnectionTarget,
    fn: (tx: TxHandle) => Promise<T>,
  ): Promise<T> {
    const opts = {
      minVersion: this.minVersionFor(t, true),
      timeoutMs: LONG_TIMEOUT_MS,
    };
    const { txId } = await this.send<{ txId: string }>(
      t.userId,
      'tx_begin',
      this.connectionPayload(t),
      opts,
    );
    const exec = async (statements: Statement[]): Promise<RunResult[]> => {
      const out: RunResult[] = [];
      for (let i = 0; i < statements.length; i += STATEMENTS_PER_MESSAGE) {
        const chunk = statements.slice(i, i + STATEMENTS_PER_MESSAGE);
        const res = await this.send<{ results: RunResult[] }>(
          t.userId,
          'tx_query',
          { txId, statements: chunk },
          opts,
        );
        out.push(...(res.results ?? []));
      }
      return out;
    };
    const handle: TxHandle = {
      run: async (sql, params, paramKinds) =>
        (await exec([{ sql, params, paramKinds }]))[0],
      runMany: exec,
    };
    try {
      const result = await fn(handle);
      await this.send(t.userId, 'tx_end', { txId, commit: true }, opts);
      return result;
    } catch (e) {
      await this.send(t.userId, 'tx_end', { txId, commit: false }, opts).catch(
        () => undefined,
      );
      throw e;
    }
  }

  async test(t: ConnectionTarget): Promise<void> {
    await this.run(t, 'SELECT 1');
  }
}

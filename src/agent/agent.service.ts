import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  GatewayTimeoutException,
} from '@nestjs/common';
import { Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { ClusterType } from '../clusters/entities/cluster.entity';

export interface AgentQueryPayload {
  requestId: string;
  type: ClusterType;
  sql: string;
  params: any[];
  namedParams?: Record<string, any>;
  host: string;
  port: number;
  username: string;
  password: string | null;
  database: string;
}

interface PendingRequest {
  resolve: (value: { rows: any[]; rowCount: number }) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly agentSockets = new Map<string, Socket>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly TIMEOUT_MS = 30_000;

  registerAgent(agentKey: string, socket: Socket): void {
    const existing = this.agentSockets.get(agentKey);
    if (existing && existing.id !== socket.id) {
      existing.disconnect(true);
    }
    this.agentSockets.set(agentKey, socket);
    this.logger.log(`Agent registered: key=${agentKey} socket=${socket.id}`);
  }

  deregisterAgent(agentKey: string, socketId: string): void {
    const sock = this.agentSockets.get(agentKey);
    if (sock?.id === socketId) {
      this.agentSockets.delete(agentKey);
      this.logger.log(`Agent deregistered: key=${agentKey}`);
    }
  }

  deregisterByKey(agentKey: string): void {
    const sock = this.agentSockets.get(agentKey);
    if (sock) {
      sock.emit('auth_error', {
        message: 'Agent key has been rotated. Please restart with the new key.',
      });
      sock.disconnect(true);
      this.agentSockets.delete(agentKey);
      this.logger.log(
        `Agent force-disconnected on key rotation: key=${agentKey}`,
      );
    }
  }

  isAgentConnected(agentKey: string): boolean {
    const sock = this.agentSockets.get(agentKey);
    return !!(sock && sock.connected);
  }

  async routeQuery(
    cluster: {
      agentKey: string;
      type: ClusterType;
      host: string;
      port: number;
      username: string;
      password: string | null;
      database: string;
    },
    sql: string,
    params: any[] = [],
    namedParams: Record<string, any> = {},
  ): Promise<{ rows: any[]; rowCount: number }> {
    const socket = this.agentSockets.get(cluster.agentKey);
    if (!socket || !socket.connected) {
      throw new ServiceUnavailableException(
        'Local agent is not connected. Please start the agent CLI on your machine.',
      );
    }

    const requestId = randomUUID();
    const payload: AgentQueryPayload = {
      requestId,
      type: cluster.type,
      sql,
      params,
      namedParams,
      host: cluster.host,
      port: cluster.port,
      username: cluster.username,
      password: cluster.password,
      database: cluster.database,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new GatewayTimeoutException('Agent did not respond within 30s'));
      }, this.TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      socket.emit('query', payload);
    });
  }

  handleResult(requestId: string, rows: any[], rowCount: number): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.resolve({ rows, rowCount });
  }

  handleError(requestId: string, message: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.reject(new Error(message));
  }
}

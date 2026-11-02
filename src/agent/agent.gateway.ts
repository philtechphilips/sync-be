import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { AgentService, sanitizeConnections } from './agent.service';
import { config } from '../config/config.service';

const REGISTER_TIMEOUT_MS = 15_000;

@WebSocketGateway({
  namespace: '/agent',
  cors: { origin: [config.FRONTEND_URL] },
  // Query results can be large; Socket.IO's default limit is 1 MB.
  maxHttpBufferSize: 100 * 1024 * 1024,
})
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AgentGateway.name);
  private readonly socketToUserId = new Map<string, string>();
  private readonly registerTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly agentService: AgentService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  handleConnection(socket: Socket) {
    // Sockets that never authenticate are dropped.
    const timer = setTimeout(() => {
      if (!this.socketToUserId.has(socket.id)) socket.disconnect(true);
    }, REGISTER_TIMEOUT_MS);
    this.registerTimers.set(socket.id, timer);
  }

  handleDisconnect(socket: Socket) {
    clearTimeout(this.registerTimers.get(socket.id));
    this.registerTimers.delete(socket.id);
    const userId = this.socketToUserId.get(socket.id);
    this.socketToUserId.delete(socket.id);
    void this.agentService.socketClosed(socket.id, userId);
  }

  @SubscribeMessage('register')
  async handleRegister(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: { agentKey?: string; version?: string; connections?: unknown },
  ) {
    const agentKey = typeof data?.agentKey === 'string' ? data.agentKey : '';
    if (!agentKey) {
      socket.emit('auth_error', { message: 'agentKey is required' });
      socket.disconnect(true);
      return;
    }

    const user = await this.userRepo.findOne({
      where: { agentKey },
      select: ['id'],
    });
    if (!user) {
      socket.emit('auth_error', { message: 'Invalid agent key' });
      socket.disconnect(true);
      return;
    }

    clearTimeout(this.registerTimers.get(socket.id));
    this.registerTimers.delete(socket.id);
    this.socketToUserId.set(socket.id, user.id);
    const version =
      typeof data?.version === 'string' ? data.version.slice(0, 20) : null;
    await this.agentService.registerAgent(
      user.id,
      socket,
      version,
      sanitizeConnections(data?.connections),
    );
    socket.emit('registered', { userId: user.id });
  }

  /** Sent by the agent when its saved connections change. */
  @SubscribeMessage('connections')
  handleConnections(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: any,
  ) {
    const userId = this.socketToUserId.get(socket.id);
    if (!userId) return;
    void this.agentService.updateConnections(
      userId,
      socket.id,
      sanitizeConnections(data?.connections),
    );
  }

  @SubscribeMessage('result')
  handleResult(@ConnectedSocket() socket: Socket, @MessageBody() data: any) {
    if (!this.socketToUserId.has(socket.id)) return;
    this.agentService.handleResult(socket.id, data);
  }

  @SubscribeMessage('error')
  handleError(@ConnectedSocket() socket: Socket, @MessageBody() data: any) {
    if (!this.socketToUserId.has(socket.id)) return;
    this.agentService.handleError(socket.id, data);
  }
}

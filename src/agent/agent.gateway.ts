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
import { AgentService } from './agent.service';

@WebSocketGateway({
  namespace: '/agent',
  cors: { origin: '*' },
})
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AgentGateway.name);
  // socketId → userId, for cleanup on disconnect
  private readonly socketToUserId = new Map<string, string>();

  constructor(
    private readonly agentService: AgentService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  handleConnection(socket: Socket) {
    this.logger.log(`Agent socket connected: ${socket.id}`);
  }

  handleDisconnect(socket: Socket) {
    const userId = this.socketToUserId.get(socket.id);
    if (userId) {
      this.agentService.deregisterAgent(userId, socket.id);
      this.socketToUserId.delete(socket.id);
    }
    this.logger.log(`Agent socket disconnected: ${socket.id}`);
  }

  @SubscribeMessage('register')
  async handleRegister(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { agentKey: string },
  ) {
    const { agentKey } = data ?? {};
    if (!agentKey) {
      socket.emit('auth_error', { message: 'agentKey is required' });
      socket.disconnect(true);
      return;
    }

    const user = await this.userRepo.findOne({
      where: { agentKey },
      select: ['id', 'agentKey'],
    });

    if (!user) {
      socket.emit('auth_error', { message: 'Invalid agent key' });
      socket.disconnect(true);
      return;
    }

    this.socketToUserId.set(socket.id, user.id);
    this.agentService.registerAgent(user.id, socket);
    socket.emit('registered', { userId: user.id });
    this.logger.log(`Agent authenticated for user ${user.id}`);
  }

  @SubscribeMessage('result')
  handleResult(
    @MessageBody()
    data: { requestId: string; rows: any[]; rowCount: number },
  ) {
    this.agentService.handleResult(data.requestId, data.rows, data.rowCount);
  }

  @SubscribeMessage('error')
  handleError(@MessageBody() data: { requestId: string; message: string }) {
    this.agentService.handleError(data.requestId, data.message);
  }
}

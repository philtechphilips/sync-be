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
import { Cluster } from '../clusters/entities/cluster.entity';
import { AgentService } from './agent.service';

@WebSocketGateway({
  namespace: '/agent',
  cors: { origin: '*' },
})
export class AgentGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AgentGateway.name);
  // socketId → agentKey, for cleanup on disconnect
  private readonly socketToKey = new Map<string, string>();

  constructor(
    private readonly agentService: AgentService,
    @InjectRepository(Cluster)
    private readonly clusterRepo: Repository<Cluster>,
  ) {}

  handleConnection(socket: Socket) {
    this.logger.log(`Agent socket connected: ${socket.id}`);
  }

  handleDisconnect(socket: Socket) {
    const agentKey = this.socketToKey.get(socket.id);
    if (agentKey) {
      this.agentService.deregisterAgent(agentKey, socket.id);
      this.socketToKey.delete(socket.id);
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

    const cluster = await this.clusterRepo.findOne({
      where: { agentKey },
      select: ['id', 'agentKey', 'userId'],
    });

    if (!cluster) {
      socket.emit('auth_error', { message: 'Invalid agent key' });
      socket.disconnect(true);
      return;
    }

    this.socketToKey.set(socket.id, agentKey);
    this.agentService.registerAgent(agentKey, socket);
    socket.emit('registered', { clusterId: cluster.id });
    this.logger.log(`Agent authenticated for cluster ${cluster.id}`);
  }

  @SubscribeMessage('result')
  handleResult(
    @MessageBody()
    data: { requestId: string; rows: any[]; rowCount: number },
  ) {
    this.agentService.handleResult(data.requestId, data.rows, data.rowCount);
  }

  @SubscribeMessage('error')
  handleError(
    @MessageBody() data: { requestId: string; message: string },
  ) {
    this.agentService.handleError(data.requestId, data.message);
  }
}

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Request,
  Query,
  Patch,
  BadRequestException,
} from '@nestjs/common';
import { Cluster } from './entities/cluster.entity';
import { ClustersService, Filter } from './clusters.service';
import { TransferService } from './transfer.service';
import { CreateClusterDto, UpdateClusterDto } from './dto/create-cluster.dto';
import {
  DeleteRowsDto,
  ExecuteQueryDto,
  RestoreDto,
  SyncSchemaDto,
  UpdateRowsDto,
} from './dto/data.dto';
import { UserOwnedController } from '../common/controllers/user-owned.controller';

@Controller('/v1/clusters')
export class ClustersController extends UserOwnedController<Cluster> {
  constructor(
    private readonly clustersService: ClustersService,
    private readonly transferService: TransferService,
  ) {
    super(clustersService);
  }

  @Post()
  async create(@Request() req: any, @Body() dto: CreateClusterDto) {
    return this.clustersService.create(req.user.id, dto);
  }

  @Post('/test')
  async test(@Request() req: any, @Body() dto: CreateClusterDto) {
    return this.clustersService.testConnection(dto, req.user.id);
  }

  @Patch(':id')
  async update(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateClusterDto,
  ) {
    return this.clustersService.updateCluster(id, req.user.id, dto);
  }

  @Get(':id/tables')
  async findTables(@Request() req: any, @Param('id') id: string) {
    return this.clustersService.findTables(id, req.user.id);
  }

  @Get(':id/tables/:tableName/columns')
  async findTableColumns(
    @Request() req: any,
    @Param('id') id: string,
    @Param('tableName') tableName: string,
  ) {
    return this.clustersService.findTableColumns(id, req.user.id, tableName);
  }

  @Get(':id/schema')
  async getSchema(@Request() req: any, @Param('id') id: string) {
    return this.clustersService.getSchema(id, req.user.id);
  }

  @Get(':id/tables/:tableName')
  async findTableData(
    @Request() req: any,
    @Param('id') id: string,
    @Param('tableName') tableName: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('filters') filters?: string,
  ) {
    let parsed: Filter[] = [];
    if (filters) {
      try {
        parsed = JSON.parse(filters) as Filter[];
      } catch {
        throw new BadRequestException('"filters" must be valid JSON.');
      }
      if (!Array.isArray(parsed))
        throw new BadRequestException('"filters" must be an array.');
    }
    return this.clustersService.findTableData(
      id,
      req.user.id,
      tableName,
      page ? Number.parseInt(page, 10) : 1,
      limit ? Number.parseInt(limit, 10) : 100,
      parsed,
    );
  }

  @Post(':id/tables/:tableName')
  async insertTableData(
    @Request() req: any,
    @Param('id') id: string,
    @Param('tableName') tableName: string,
    @Body() data: Record<string, unknown>,
  ) {
    return this.clustersService.insertTableData(
      id,
      req.user.id,
      tableName,
      data,
    );
  }

  @Patch(':id/tables/:tableName/rows')
  async updateTableData(
    @Request() req: any,
    @Param('id') id: string,
    @Param('tableName') tableName: string,
    @Body() body: UpdateRowsDto,
  ) {
    return this.clustersService.updateTableData(
      id,
      req.user.id,
      tableName,
      body.data,
      body.where,
    );
  }

  @Delete(':id/tables/:tableName/rows')
  async deleteTableData(
    @Request() req: any,
    @Param('id') id: string,
    @Param('tableName') tableName: string,
    @Body() body: DeleteRowsDto,
  ) {
    return this.clustersService.deleteTableData(
      id,
      req.user.id,
      tableName,
      body,
    );
  }

  @Post(':id/query')
  async executeQuery(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: ExecuteQueryDto,
  ) {
    return this.clustersService.executeQuery(
      id,
      req.user.id,
      body.query,
      body.page,
      body.limit,
    );
  }

  @Get(':id/query/logs')
  async getQueryLogs(@Request() req: any, @Param('id') id: string) {
    return this.clustersService.getQueryLogs(id, req.user.id);
  }

  @Delete(':id/tables/:tableName')
  async dropTable(
    @Request() req: any,
    @Param('id') id: string,
    @Param('tableName') tableName: string,
  ) {
    return this.clustersService.dropTable(id, req.user.id, tableName);
  }

  @Get(':id/compare/:targetId')
  async compareSchemas(
    @Request() req: any,
    @Param('id') sourceId: string,
    @Param('targetId') targetId: string,
  ) {
    return this.clustersService.compareSchemas(sourceId, targetId, req.user.id);
  }

  @Post(':id/sync/:targetId')
  async syncSchema(
    @Request() req: any,
    @Param('id') sourceId: string,
    @Param('targetId') targetId: string,
    @Body() body: SyncSchemaDto,
  ) {
    return this.transferService.syncSchema(
      sourceId,
      targetId,
      req.user.id,
      body,
    );
  }

  @Get(':id/backup')
  async backup(
    @Request() req: any,
    @Param('id') id: string,
    @Query('format') format: 'sql' | 'csv' | 'json',
  ) {
    return this.transferService.backup(id, req.user.id, format);
  }

  @Post(':id/restore')
  async restore(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: RestoreDto,
  ) {
    return this.transferService.restore(
      id,
      req.user.id,
      body.format,
      body.data,
    );
  }
}

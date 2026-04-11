import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Request,
  UsePipes,
  ValidationPipe,
  Query,
  Patch,
} from '@nestjs/common';
import { Cluster } from './entities/cluster.entity';
import { ClustersService } from './clusters.service';
import { CreateClusterDto } from './dto/create-cluster.dto';
import { UserOwnedController } from '../common/controllers/user-owned.controller';

@Controller('/v1/clusters')
export class ClustersController extends UserOwnedController<Cluster> {
  constructor(private readonly clustersService: ClustersService) {
    super(clustersService);
  }

  @Post()
  @UsePipes(ValidationPipe)
  async create(
    @Request() req: any,
    @Body() createClusterDto: CreateClusterDto,
  ) {
    return this.clustersService.create(req.user.id, createClusterDto);
  }

  @Post('/test')
  @UsePipes(ValidationPipe)
  async test(@Body() createClusterDto: CreateClusterDto) {
    return this.clustersService.testConnection(createClusterDto);
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
    @Query('page') page: string,
    @Query('limit') limit: string,
    @Query('filters') filters: string,
  ) {
    let parsedFilters = [];
    if (filters) {
      try {
        parsedFilters = JSON.parse(filters);
      } catch (e) {
        console.error('Failed to parse filters:', e);
      }
    }

    return this.clustersService.findTableData(
      id,
      req.user.id,
      tableName,
      page ? Number.parseInt(page) : 1,
      limit ? Number.parseInt(limit) : 100,
      parsedFilters,
    );
  }

  @Post(':id/tables/:tableName')
  async insertTableData(
    @Request() req: any,
    @Param('id') id: string,
    @Param('tableName') tableName: string,
    @Body() data: any,
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
    @Body() body: { data: any; where: any },
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
    @Body() body: { where: any },
  ) {
    return this.clustersService.deleteTableData(
      id,
      req.user.id,
      tableName,
      body.where,
    );
  }

  @Post(':id/query')
  async executeQuery(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: { query: string; page?: number; limit?: number },
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
    @Body() body: { tableNames: string[]; withData?: boolean },
  ) {
    return this.clustersService.syncSchema(
      sourceId,
      targetId,
      req.user.id,
      body.tableNames,
      body.withData || false,
    );
  }

  @Get(':id/backup')
  async backup(
    @Request() req: any,
    @Param('id') id: string,
    @Query('format') format: 'sql' | 'csv' | 'json',
  ) {
    return this.clustersService.backup(id, req.user.id, format);
  }

  @Post(':id/restore')
  async restore(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: { format: 'sql' | 'csv' | 'json'; data: any },
  ) {
    return this.clustersService.restore(
      id,
      req.user.id,
      body.format,
      body.data,
    );
  }

}

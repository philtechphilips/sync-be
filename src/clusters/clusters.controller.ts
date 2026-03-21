import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  UseGuards,
  Request,
  UsePipes,
  ValidationPipe,
  Query,
  Patch,
} from '@nestjs/common';
import { ClustersService } from './clusters.service';
import { CreateClusterDto } from './dto/create-cluster.dto';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';

@Controller('/v1/clusters')
@UseGuards(JwtAuthGuard)
export class ClustersController {
  constructor(private readonly clustersService: ClustersService) {}

  @Get()
  async findAll(@Request() req: any) {
    return this.clustersService.findAll(req.user.id);
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

  @Get(':id')
  async findOne(@Request() req: any, @Param('id') id: string) {
    return this.clustersService.findOne(id, req.user.id);
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
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 100,
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

  @Delete(':id')
  async remove(@Request() req: any, @Param('id') id: string) {
    return this.clustersService.remove(id, req.user.id);
  }

  @Post(':id/query')
  async executeQuery(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: { query: string },
  ) {
    return this.clustersService.executeQuery(id, req.user.id, body.query);
  }

  @Get(':id/query/logs')
  async getQueryLogs(@Request() req: any, @Param('id') id: string) {
    return this.clustersService.getQueryLogs(id, req.user.id);
  }
}

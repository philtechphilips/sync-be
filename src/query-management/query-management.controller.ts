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
  Patch,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { QueryManagementService } from './query-management.service';
import {
  CreateSavedQueryDto,
  UpdateSavedQueryDto,
} from './dto/saved-query.dto';
import { CreateCollectionDto, UpdateCollectionDto } from './dto/collection.dto';

@Controller('/v1/query-management')
@UseGuards(JwtAuthGuard)
export class QueryManagementController {
  constructor(private readonly queryService: QueryManagementService) {}

  // --- Saved Queries ---

  @Post('/queries')
  @UsePipes(ValidationPipe)
  async createQuery(@Request() req: any, @Body() dto: CreateSavedQueryDto) {
    return this.queryService.createQuery(req.user.id, dto);
  }

  @Get('/queries')
  async findAllQueries(@Request() req: any) {
    return this.queryService.findAllQueries(req.user.id);
  }

  @Get('/queries/:id')
  async findOneQuery(@Request() req: any, @Param('id') id: string) {
    return this.queryService.findOneQuery(id, req.user.id);
  }

  @Patch('/queries/:id')
  @UsePipes(ValidationPipe)
  async updateQuery(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateSavedQueryDto,
  ) {
    return this.queryService.updateQuery(id, req.user.id, dto);
  }

  @Delete('/queries/:id')
  async removeQuery(@Request() req: any, @Param('id') id: string) {
    return this.queryService.removeQuery(id, req.user.id);
  }

  // --- Collections ---

  @Post('/collections')
  @UsePipes(ValidationPipe)
  async createCollection(
    @Request() req: any,
    @Body() dto: CreateCollectionDto,
  ) {
    return this.queryService.createCollection(req.user.id, dto);
  }

  @Get('/collections')
  async findAllCollections(@Request() req: any) {
    return this.queryService.findAllCollections(req.user.id);
  }

  @Get('/collections/tree')
  async getCollectionTree(@Request() req: any) {
    return this.queryService.getCollectionTree(req.user.id);
  }

  @Get('/collections/:id')
  async findOneCollection(@Request() req: any, @Param('id') id: string) {
    return this.queryService.findOneCollection(id, req.user.id);
  }

  @Patch('/collections/:id')
  @UsePipes(ValidationPipe)
  async updateCollection(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.queryService.updateCollection(id, req.user.id, dto);
  }

  @Delete('/collections/:id')
  async removeCollection(@Request() req: any, @Param('id') id: string) {
    return this.queryService.removeCollection(id, req.user.id);
  }
}

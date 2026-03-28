import {
  Get,
  Param,
  Delete,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { UserOwnedService } from '../services/user-owned.service';
import { UserOwnedEntity } from '../entities/user-owned.entity';

@UseGuards(JwtAuthGuard)
export abstract class UserOwnedController<T extends UserOwnedEntity> {
  constructor(protected readonly service: UserOwnedService<T>) {}

  @Get()
  async findAll(@Request() req: any) {
    return this.service.findAll(req.user.id);
  }

  @Get(':id')
  async findOne(@Request() req: any, @Param('id') id: string) {
    return this.service.findOne(id, req.user.id);
  }

  @Delete(':id')
  async remove(@Request() req: any, @Param('id') id: string) {
    return this.service.remove(id, req.user.id);
  }
}

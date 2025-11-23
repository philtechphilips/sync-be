import { Injectable } from '@nestjs/common';
import { BaseRepository } from '../../common/repository/base.repository';
import { Workspace } from '../entities/workspace.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

@Injectable()
export class WorkspaceRepository extends BaseRepository<Workspace> {
  constructor(
    @InjectRepository(Workspace) private workspaceModel: Repository<Workspace>,
  ) {
    super(workspaceModel);
  }
}


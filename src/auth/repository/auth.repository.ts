import { Injectable } from '@nestjs/common';
import { BaseRepository } from '../../common/repository/base.repository';
import { User } from '../entities/user.entity';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

@Injectable()
export class AuthRepo extends BaseRepository<User> {
  private readonly userRepo: Repository<User>;

  constructor(
    @InjectRepository(User) private userModel: Repository<User>,
    @InjectEntityManager() private readonly entityManager: EntityManager,
  ) {
    super(userModel);
    this.userRepo = this.entityManager.getRepository(User);
  }

  async save(data: User) {
    delete data.password;

    return await this.userRepo.save(data);
  }

  async findAll(): Promise<User[]> {
    const users = await this.userRepo.find();
    users.forEach((user) => {
      delete user.password;
    });
    return users;
  }
}

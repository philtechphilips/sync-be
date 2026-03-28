import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository, FindOptionsWhere, FindManyOptions } from 'typeorm';
import { UserOwnedEntity } from '../entities/user-owned.entity';

export abstract class UserOwnedService<T extends UserOwnedEntity> {
  constructor(
    protected readonly repository: Repository<T>,
    protected readonly resourceName: string,
  ) {}

  async findAll(
    userId: string,
    options: FindManyOptions<T> = {},
  ): Promise<T[]> {
    return this.repository.find({
      ...options,
      where: { userId, ...(options.where as any) },
      order: options.order || ({ createdAt: 'DESC' } as any),
    });
  }

  async findOne(
    id: string,
    userId: string,
    relations: string[] = [],
  ): Promise<T> {
    const resource = await this.repository.findOne({
      where: { id, userId } as FindOptionsWhere<T>,
      relations,
    });
    if (!resource) {
      throw new NotFoundException(`${this.resourceName} not found!`);
    }
    return resource;
  }

  async create(userId: string, data: any): Promise<T> {
    const resource = this.repository.create({
      ...data,
      userId,
    } as any);
    return this.repository.save(resource as any) as Promise<T>;
  }

  async update(id: string, userId: string, data: any): Promise<T> {
    const resource = await this.findOne(id, userId);
    Object.assign(resource, data);
    return this.repository.save(resource as any) as Promise<T>;
  }

  async remove(id: string, userId: string): Promise<void> {
    const resource = await this.findOne(id, userId);
    await this.repository.remove(resource);
  }
}

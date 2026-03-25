import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SavedQuery } from './entities/saved-query.entity';
import { Collection } from './entities/collection.entity';
import {
  CreateSavedQueryDto,
  UpdateSavedQueryDto,
} from './dto/saved-query.dto';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
} from './dto/collection.dto';

@Injectable()
export class QueryManagementService {
  constructor(
    @InjectRepository(SavedQuery)
    private readonly queryRepo: Repository<SavedQuery>,
    @InjectRepository(Collection)
    private readonly collectionRepo: Repository<Collection>,
  ) {}

  // --- Saved Queries ---

  async createQuery(userId: string, dto: CreateSavedQueryDto) {
    const query = this.queryRepo.create({
      ...dto,
      userId,
    });
    return this.queryRepo.save(query);
  }

  async findAllQueries(userId: string) {
    return this.queryRepo.find({
      where: { userId },
      relations: ['collection', 'cluster'],
      order: { updatedAt: 'DESC' },
    });
  }

  async findOneQuery(id: string, userId: string) {
    const query = await this.queryRepo.findOne({
      where: { id, userId },
      relations: ['collection', 'cluster'],
    });
    if (!query) throw new NotFoundException('Saved query not found');
    return query;
  }

  async updateQuery(id: string, userId: string, dto: UpdateSavedQueryDto) {
    const query = await this.findOneQuery(id, userId);
    Object.assign(query, dto);
    return this.queryRepo.save(query);
  }

  async removeQuery(id: string, userId: string) {
    const query = await this.findOneQuery(id, userId);
    return this.queryRepo.remove(query);
  }

  // --- Collections ---

  async createCollection(userId: string, dto: CreateCollectionDto) {
    const collection = this.collectionRepo.create({
      ...dto,
      userId,
    });
    return this.collectionRepo.save(collection);
  }

  async findAllCollections(userId: string) {
    return this.collectionRepo.find({
      where: { userId },
      relations: ['children', 'queries'],
      order: { name: 'ASC' },
    });
  }

  async findOneCollection(id: string, userId: string) {
    const collection = await this.collectionRepo.findOne({
      where: { id, userId },
      relations: ['children', 'queries'],
    });
    if (!collection) throw new NotFoundException('Collection not found');
    return collection;
  }

  async updateCollection(id: string, userId: string, dto: UpdateCollectionDto) {
    const collection = await this.findOneCollection(id, userId);
    Object.assign(collection, dto);
    return this.collectionRepo.save(collection);
  }

  async removeCollection(id: string, userId: string) {
    const collection = await this.findOneCollection(id, userId);
    // Note: TypeORM relation is set to CASCADE for children, but queries are SET NULL
    return this.collectionRepo.remove(collection);
  }

  async getCollectionTree(userId: string) {
    const allCollections = await this.collectionRepo.find({
      where: { userId },
      relations: ['queries'],
    });

    const rootCollections = allCollections.filter((c) => !c.parentId);
    
    const buildTree = (collection: Collection): any => {
      const children = allCollections.filter((c) => c.parentId === collection.id);
      return {
        ...collection,
        children: children.map(buildTree),
      };
    };

    return rootCollections.map(buildTree);
  }
}

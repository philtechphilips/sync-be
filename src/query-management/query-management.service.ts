import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SavedQuery } from './entities/saved-query.entity';
import { Collection } from './entities/collection.entity';
import { Cluster } from '../clusters/entities/cluster.entity';
import {
  CreateSavedQueryDto,
  UpdateSavedQueryDto,
} from './dto/saved-query.dto';
import { CreateCollectionDto, UpdateCollectionDto } from './dto/collection.dto';

@Injectable()
export class QueryManagementService {
  constructor(
    @InjectRepository(SavedQuery)
    private readonly queryRepo: Repository<SavedQuery>,
    @InjectRepository(Collection)
    private readonly collectionRepo: Repository<Collection>,
    @InjectRepository(Cluster)
    private readonly clusterRepo: Repository<Cluster>,
  ) {}

  /** Referenced clusters/collections must belong to the same user. */
  private async assertOwned(
    userId: string,
    refs: { clusterId?: string | null; collectionId?: string | null },
  ) {
    if (
      refs.clusterId &&
      !(await this.clusterRepo.exists({
        where: { id: refs.clusterId, userId },
      }))
    ) {
      throw new BadRequestException('Cluster not found.');
    }
    if (
      refs.collectionId &&
      !(await this.collectionRepo.exists({
        where: { id: refs.collectionId, userId },
      }))
    ) {
      throw new BadRequestException('Collection not found.');
    }
  }

  // --- Saved Queries ---

  async createQuery(userId: string, dto: CreateSavedQueryDto) {
    await this.assertOwned(userId, dto);
    const query = this.queryRepo.create({
      name: dto.name,
      query: dto.query,
      clusterId: dto.clusterId,
      collectionId: dto.collectionId,
      tags: dto.tags,
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
    await this.assertOwned(userId, dto);
    for (const key of [
      'name',
      'query',
      'clusterId',
      'collectionId',
      'tags',
    ] as const) {
      if (dto[key] !== undefined) (query as any)[key] = dto[key];
    }
    // Drop loaded relations so TypeORM saves the new foreign keys.
    const { cluster: _cluster, collection: _collection, ...plain } = query;
    return this.queryRepo.save(plain);
  }

  async removeQuery(id: string, userId: string) {
    const query = await this.findOneQuery(id, userId);
    return this.queryRepo.remove(query);
  }

  // --- Collections ---

  async createCollection(userId: string, dto: CreateCollectionDto) {
    await this.assertOwned(userId, { collectionId: dto.parentId });
    const collection = this.collectionRepo.create({
      name: dto.name,
      parentId: dto.parentId,
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
    if (dto.parentId !== undefined && dto.parentId !== null) {
      await this.assertOwned(userId, { collectionId: dto.parentId });
      // A folder can't be moved into itself or one of its own descendants.
      const all = await this.collectionRepo.find({
        where: { userId },
        select: ['id', 'parentId'],
      });
      const parentOf = new Map(all.map((c) => [c.id, c.parentId]));
      for (
        let cur: string | null | undefined = dto.parentId;
        cur;
        cur = parentOf.get(cur)
      ) {
        if (cur === id)
          throw new BadRequestException(
            'A collection cannot be moved into itself.',
          );
      }
    }
    if (dto.name !== undefined) collection.name = dto.name;
    if (dto.parentId !== undefined) collection.parentId = dto.parentId;
    const {
      children: _children,
      queries: _queries,
      parent: _parent,
      ...plain
    } = collection;
    return this.collectionRepo.save(plain);
  }

  async removeCollection(id: string, userId: string) {
    const collection = await this.findOneCollection(id, userId);
    return this.collectionRepo.remove(collection);
  }

  async getCollectionTree(userId: string) {
    const allCollections = await this.collectionRepo.find({
      where: { userId },
      relations: ['queries'],
    });

    const rootCollections = allCollections.filter((c) => !c.parentId);

    const buildTree = (collection: Collection): any => {
      const children = allCollections.filter(
        (c) => c.parentId === collection.id,
      );
      return {
        ...collection,
        children: children.map(buildTree),
      };
    };

    return rootCollections.map(buildTree);
  }
}

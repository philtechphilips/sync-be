import {
  DeepPartial,
  Repository,
  FindOptionsWhere,
  DeleteResult,
  FindManyOptions,
  SelectQueryBuilder,
  FindOptionsRelations,
} from 'typeorm';
import { IPaginationQuery } from '../interfaces/date-query';

export abstract class BaseRepository<T> {
  constructor(protected readonly entity: Repository<T>) {}

  async findOne(
    entityFilterQuery: FindOptionsWhere<T>,
    relations?: FindOptionsRelations<T>,
    projection?: Record<string, any>,
  ): Promise<T | undefined> {
    return this.entity.findOne({
      where: entityFilterQuery,
      relations: relations,
      select: projection,
    });
  }

  async find(entityFilterQuery: FindOptionsWhere<T> | FindManyOptions<T>): Promise<T[]> {
    return this.entity.find(entityFilterQuery);
  }

  async findAll(): Promise<T[]> {
    return this.entity.find();
  }

  async create(createEntityData: DeepPartial<T>): Promise<T> {
    const entity = this.entity.create(createEntityData);
    return this.entity.save(entity);
  }

  async findOneAndUpdate(
    entityFilterQuery: FindOptionsWhere<T>,
    updateEntityData: Partial<unknown>,
  ): Promise<T | undefined> {
    await this.entity.update(entityFilterQuery, updateEntityData);
    return this.entity.findOne({ where: entityFilterQuery });
  }

  async deleteMany(entityFilterQuery: FindOptionsWhere<T>): Promise<boolean> {
    const result: DeleteResult = await this.entity.delete(entityFilterQuery);
    return result.affected! > 0;
  }

  async createQueryBuilder(alias?: string): Promise<SelectQueryBuilder<T>> {
    return this.entity.createQueryBuilder(alias);
  }

  async saveMany(data: DeepPartial<T>[]): Promise<T[]> {
    return this.entity.save(data);
  }
}

export async function applyPagination<T>(
  queryBuilder: SelectQueryBuilder<T>,
  pagination: IPaginationQuery,
): Promise<SelectQueryBuilder<T>> {
  const { currentPage, pageSize } = pagination;

  const numbersOfItems = pageSize || 10;
  const current = currentPage || 1;

  const skip = (current - 1) * numbersOfItems;

  return queryBuilder.skip(skip).take(numbersOfItems);
}

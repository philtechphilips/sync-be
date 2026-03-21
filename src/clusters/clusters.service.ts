import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as mysql from 'mysql2/promise';
import { Client as PGClient } from 'pg';
import { Cluster, ClusterType } from './entities/cluster.entity';
import { CreateClusterDto } from './dto/create-cluster.dto';
import { CryptographyService } from '../common/services/cryptography.service';

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class ClustersService {
  private mysqlPools = new Map<string, mysql.Pool>();
  private pgPools = new Map<string, any>(); // pg.Pool is not exported directly in some versions

  constructor(
    @InjectRepository(Cluster)
    private readonly clusterRepo: Repository<Cluster>,
    private readonly cryptographyService: CryptographyService,
  ) {}

  private getMySQLPool(cluster: Cluster): mysql.Pool {
    const { id, host, port, username, database, password } = cluster;
    let pool = this.mysqlPools.get(id);
    if (!pool) {
      pool = mysql.createPool({
        host,
        port,
        user: username,
        password,
        database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
      });
      this.mysqlPools.set(id, pool);
    }
    return pool;
  }

  private getPGPool(cluster: Cluster): any {
    const { id, host, port, username, database, password } = cluster;
    let pool = this.pgPools.get(id);
    if (!pool) {
      // Lazy load pg to avoid issues if not needed
      const { Pool } = require('pg');
      pool = new Pool({
        host,
        port,
        user: username,
        password,
        database,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
      });

      // Add error listener to handle unexpected connection drops
      pool.on('error', (err: any) => {
        console.error(
          `Unexpected error on idle client for cluster ${id}:`,
          err,
        );
      });

      this.pgPools.set(id, pool);
    }
    return pool;
  }

  private decryptCluster(cluster: Cluster): Cluster {
    if (!cluster) return cluster;
    const sensitiveFields: (keyof Cluster)[] = [
      'name',
      'host',
      'username',
      'password',
      'database',
    ];
    sensitiveFields.forEach((field) => {
      if (typeof cluster[field] === 'string') {
        (cluster as any)[field] =
          this.cryptographyService.decrypt(cluster[field] as string) ||
          cluster[field];
      }
    });
    return cluster;
  }

  async findAll(userId: string) {
    const clusters = await this.clusterRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return clusters.map((c) => this.decryptCluster(c));
  }

  async findOne(id: string, userId: string) {
    const cluster = await this.clusterRepo.findOne({ where: { id, userId } });
    if (!cluster) {
      throw new BadRequestException('Cluster not found!');
    }
    return this.decryptCluster(cluster);
  }

  async testConnection(createClusterDto: CreateClusterDto) {
    const { type, host, port, username, password, database } = createClusterDto;

    if (type === ClusterType.MYSQL) {
      try {
        const connection = await mysql.createConnection({
          host,
          port,
          user: username,
          password,
          database,
          connectTimeout: 5000,
        });
        await connection.end();
        return { success: true, message: 'MySQL connection successful!' };
      } catch (error) {
        throw new BadRequestException(
          `MySQL connection failed: ${error.message}`,
        );
      }
    } else if (type === ClusterType.POSTGRES) {
      const client = new PGClient({
        host,
        port,
        user: username,
        password,
        database,
        connectionTimeoutMillis: 5000,
      });

      try {
        await client.connect();
        await client.end();
        return { success: true, message: 'PostgreSQL connection successful!' };
      } catch (error) {
        throw new BadRequestException(
          `PostgreSQL connection failed: ${error.message}`,
        );
      }
    }

    throw new BadRequestException('Invalid database type!');
  }

  async create(userId: string, createClusterDto: CreateClusterDto) {
    // First test the connection
    await this.testConnection(createClusterDto);

    const cluster = this.clusterRepo.create({
      ...createClusterDto,
      name: this.cryptographyService.encrypt(createClusterDto.name) as string,
      host: this.cryptographyService.encrypt(createClusterDto.host) as string,
      username: this.cryptographyService.encrypt(
        createClusterDto.username,
      ) as string,
      password:
        this.cryptographyService.encrypt(createClusterDto.password) ??
        undefined,
      database: this.cryptographyService.encrypt(
        createClusterDto.database,
      ) as string,
      userId,
    });

    const saved = await this.clusterRepo.save(cluster);
    return this.decryptCluster(saved);
  }

  async findTables(id: string, userId: string) {
    const cluster = await this.findOne(id, userId);
    const { type, database } = cluster;

    if (type === ClusterType.MYSQL) {
      try {
        const pool = this.getMySQLPool(cluster);
        const [rows]: [any[], any] = await pool.query(
          'SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = ? ORDER BY table_name ASC',
          [database, 'BASE TABLE'],
        );
        return rows.map((row: any) => ({
          name: row.TABLE_NAME || row.table_name,
        }));
      } catch (error) {
        console.error('findTables MySQL error:', error);
        throw new BadRequestException(
          `Failed to fetch MySQL tables: ${error.message}`,
        );
      }
    } else if (type === ClusterType.POSTGRES) {
      try {
        const pool = this.getPGPool(cluster);
        const res = await pool.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name ASC",
        );
        return res.rows.map((row: any) => ({ name: row.table_name }));
      } catch (error) {
        console.error('findTables error:', error);
        throw new BadRequestException(
          `Failed to fetch PostgreSQL tables: ${error.message}`,
        );
      }
    }
  }

  async findTableColumns(id: string, userId: string, tableName: string) {
    const cluster = await this.findOne(id, userId);
    const { type, database } = cluster;

    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
      throw new BadRequestException('Invalid table name!');
    }

    if (type === ClusterType.MYSQL) {
      try {
        const pool = this.getMySQLPool(cluster);
        const [rows]: [any[], any] = await pool.query(
          `SELECT 
            cols.COLUMN_NAME as name, 
            cols.DATA_TYPE as type, 
            cols.COLUMN_TYPE as fullType, 
            cols.IS_NULLABLE as nullable, 
            cols.COLUMN_DEFAULT as defaultValue, 
            cols.COLUMN_KEY as columnKey,
            fk.REFERENCED_TABLE_NAME as referencedTable,
            fk.REFERENCED_COLUMN_NAME as referencedColumn
          FROM information_schema.columns cols
          LEFT JOIN information_schema.KEY_COLUMN_USAGE fk 
            ON cols.TABLE_SCHEMA = fk.TABLE_SCHEMA 
            AND cols.TABLE_NAME = fk.TABLE_NAME 
            AND cols.COLUMN_NAME = fk.COLUMN_NAME 
            AND fk.REFERENCED_TABLE_NAME IS NOT NULL
          WHERE cols.table_schema = ? AND cols.table_name = ?`,
          [database, tableName],
        );
        return rows;
      } catch (error) {
        throw new BadRequestException(
          `Failed to fetch MySQL columns: ${error.message}`,
        );
      }
    } else if (type === ClusterType.POSTGRES) {
      try {
        const pool = this.getPGPool(cluster);
        const res = await pool.query(
          `SELECT 
            cols.column_name as name, 
            cols.data_type as type, 
            cols.is_nullable as nullable, 
            cols.column_default as "defaultValue",
            cols.udt_name as "udtName",
            (SELECT string_agg(enumlabel, ',') FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid WHERE pg_type.typname = cols.udt_name) as "enumValues",
            kcu.referenced_table_name as "referencedTable",
            kcu.referenced_column_name as "referencedColumn"
          FROM information_schema.columns cols
          LEFT JOIN (
              SELECT 
                  kcu.table_name, 
                  kcu.column_name, 
                  ccu.table_name AS referenced_table_name, 
                  ccu.column_name AS referenced_column_name 
              FROM information_schema.key_column_usage kcu
              JOIN information_schema.table_constraints tc ON kcu.constraint_name = tc.constraint_name
              JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
              WHERE tc.constraint_type = 'FOREIGN KEY'
          ) kcu ON cols.table_name = kcu.table_name AND cols.column_name = kcu.column_name
          WHERE cols.table_schema = 'public' AND cols.table_name = $1`,
          [tableName],
        );
        return res.rows;
      } catch (error) {
        throw new BadRequestException(
          `Failed to fetch PostgreSQL columns: ${error.message}`,
        );
      }
    }
  }

  private async executePaginatedQuery(
    cluster: Cluster,
    tableName: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResponse<any>> {
    const { type } = cluster;
    const offset = (page - 1) * limit;

    if (type === ClusterType.MYSQL) {
      const pool = this.getMySQLPool(cluster);
      const [rows]: [any[], any] = await pool.query(
        `SELECT * FROM \`${tableName}\` LIMIT ? OFFSET ?`,
        [Number(limit), Number(offset)],
      );
      const [countResult]: [any[], any] = await pool.query(
        `SELECT COUNT(*) as total FROM \`${tableName}\``,
      );
      return {
        data: rows,
        total: Number(countResult[0]?.total || 0),
        page: Number(page),
        limit: Number(limit),
      };
    } else {
      const pool = this.getPGPool(cluster);
      const res = await pool.query(
        `SELECT * FROM "${tableName}" LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      const countRes = await pool.query(
        `SELECT COUNT(*) as total FROM "${tableName}"`,
      );
      return {
        data: res.rows,
        total: parseInt(countRes.rows[0]?.total || '0'),
        page: Number(page),
        limit: Number(limit),
      };
    }
  }

  async findTableData(
    id: string,
    userId: string,
    tableName: string,
    page: number = 1,
    limit: number = 100,
  ) {
    const cluster = await this.findOne(id, userId);

    // Sanitize table name: only allow alphanumeric and underscores
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
      throw new BadRequestException('Invalid table name!');
    }

    try {
      return await this.executePaginatedQuery(cluster, tableName, page, limit);
    } catch (error) {
      console.error(`findTableData error for ${cluster.type}:`, error);
      throw new BadRequestException(
        `Failed to fetch ${cluster.type} data: ${error.message}`,
      );
    }
  }

  async updateTableData(
    id: string,
    userId: string,
    tableName: string,
    data: any,
    where: any,
  ) {
    const cluster = await this.findOne(id, userId);
    const { type } = cluster;

    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
      throw new BadRequestException('Invalid table name!');
    }

    const setKeys = Object.keys(data);
    const setClause = setKeys
      .map(
        (key, i) =>
          `${type === ClusterType.MYSQL ? `\`${key}\`` : `"${key}"`} = ${
            type === ClusterType.MYSQL ? '?' : `$${i + 1}`
          }`,
      )
      .join(', ');

    const whereKeys = Object.keys(where);
    const whereClause = whereKeys
      .map(
        (key, i) =>
          `${type === ClusterType.MYSQL ? `\`${key}\`` : `"${key}"`} = ${
            type === ClusterType.MYSQL ? '?' : `$${setKeys.length + i + 1}`
          }`,
      )
      .join(' AND ');

    const values = [...Object.values(data), ...Object.values(where)];

    if (type === ClusterType.MYSQL) {
      try {
        const pool = this.getMySQLPool(cluster);
        const [result] = await pool.query(
          `UPDATE \`${tableName}\` SET ${setClause} WHERE ${whereClause}`,
          values,
        );
        return result;
      } catch (error) {
        throw new BadRequestException(
          `Failed to update MySQL data: ${error.message}`,
        );
      }
    } else if (type === ClusterType.POSTGRES) {
      try {
        const pool = this.getPGPool(cluster);
        const res = await pool.query(
          `UPDATE "${tableName}" SET ${setClause} WHERE ${whereClause}`,
          values,
        );
        return res.rowCount;
      } catch (error) {
        throw new BadRequestException(
          `Failed to update PostgreSQL data: ${error.message}`,
        );
      }
    }
  }

  async insertTableData(
    id: string,
    userId: string,
    tableName: string,
    data: any,
  ) {
    const cluster = await this.findOne(id, userId);
    const { type } = cluster;

    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
      throw new BadRequestException('Invalid table name!');
    }

    const keys = Object.keys(data);
    const values = Object.values(data);

    if (keys.length === 0) {
      throw new BadRequestException('No data provided for insertion');
    }

    if (type === ClusterType.MYSQL) {
      try {
        const pool = this.getMySQLPool(cluster);
        const columnNames = keys.map((k) => `\`${k}\``).join(', ');
        const placeholders = keys.map(() => '?').join(', ');
        const [result] = await pool.query(
          `INSERT INTO \`${tableName}\` (${columnNames}) VALUES (${placeholders})`,
          values,
        );
        return result;
      } catch (error) {
        throw new BadRequestException(
          `Failed to insert MySQL data: ${error.message}`,
        );
      }
    } else if (type === ClusterType.POSTGRES) {
      try {
        const pool = this.getPGPool(cluster);
        const columnNames = keys.map((k) => `"${k}"`).join(', ');
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
        const res = await pool.query(
          `INSERT INTO "${tableName}" (${columnNames}) VALUES (${placeholders}) RETURNING *`,
          values,
        );
        return res.rows[0];
      } catch (error) {
        throw new BadRequestException(
          `Failed to insert PostgreSQL data: ${error.message}`,
        );
      }
    }
  }

  async deleteTableData(
    id: string,
    userId: string,
    tableName: string,
    where: any,
  ) {
    const cluster = await this.findOne(id, userId);
    const { type } = cluster;

    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
      throw new BadRequestException('Invalid table name!');
    }

    const whereKeys = Object.keys(where);
    if (whereKeys.length === 0) {
      throw new BadRequestException(
        'Delete operation requires conditions to prevent accidental full table wipe',
      );
    }

    const whereClause = whereKeys
      .map(
        (key, i) =>
          `${type === ClusterType.MYSQL ? `\`${key}\`` : `"${key}"`} = ${type === ClusterType.MYSQL ? '?' : `$${i + 1}`}`,
      )
      .join(' AND ');

    const values = Object.values(where);

    if (type === ClusterType.MYSQL) {
      try {
        const pool = this.getMySQLPool(cluster);
        const [result] = await pool.query(
          `DELETE FROM \`${tableName}\` WHERE ${whereClause}`,
          values,
        );
        return result;
      } catch (error) {
        throw new BadRequestException(
          `Failed to delete MySQL data: ${error.message}`,
        );
      }
    } else if (type === ClusterType.POSTGRES) {
      try {
        const pool = this.getPGPool(cluster);
        const res = await pool.query(
          `DELETE FROM "${tableName}" WHERE ${whereClause}`,
          values,
        );
        return res.rowCount;
      } catch (error) {
        throw new BadRequestException(
          `Failed to delete PostgreSQL data: ${error.message}`,
        );
      }
    }
  }

  async remove(id: string, userId: string) {
    const cluster = await this.findOne(id, userId);
    return this.clusterRepo.remove(cluster);
  }
}

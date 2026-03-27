import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as mysql from 'mysql2/promise';
import { Client } from 'pg';
import * as mssql from 'mssql';
import { Cluster, ClusterType } from './entities/cluster.entity';
import { QueryLog } from './entities/query-log.entity';
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
  private pgPools = new Map<string, any>();
  private mssqlPools = new Map<string, mssql.ConnectionPool>();

  constructor(
    @InjectRepository(Cluster)
    private readonly clusterRepo: Repository<Cluster>,
    @InjectRepository(QueryLog)
    private readonly queryLogRepo: Repository<QueryLog>,
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
        multipleStatements: true,
      });
      this.mysqlPools.set(id, pool);
    }
    return pool;
  }

  private getPGPool(cluster: Cluster): any {
    const { id, host, port, username, database, password } = cluster;
    let pool = this.pgPools.get(id);
    if (!pool) {
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

  private async getMSSQLPool(cluster: Cluster): Promise<mssql.ConnectionPool> {
    const { id, host, port, username, database, password } = cluster;
    let pool = this.mssqlPools.get(id);
    if (!pool || !pool.connected) {
      const config: mssql.config = {
        server: host,
        port: port || 1433,
        user: username,
        password: password,
        database: database,
        options: {
          encrypt: true,
          trustServerCertificate: true,
        },
      };
      pool = new mssql.ConnectionPool(config);
      await pool.connect();
      this.mssqlPools.set(id, pool);
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

    try {
      sensitiveFields.forEach((field) => {
        const value = cluster[field];
        if (typeof value === 'string' && value !== '') {
          const parts = value.split(':');
          if (parts.length === 3) {
            (cluster as any)[field] = this.cryptographyService.decrypt(value);
          }
        }
      });
      return cluster;
    } catch (error) {
      throw new BadRequestException(
        `Failed to unlock cluster credentials: ${error.message}`,
      );
    }
  }

  async findAll(userId: string): Promise<Cluster[]> {
    const clusters = await this.clusterRepo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return clusters.map((c) => this.decryptCluster(c));
  }

  async findOne(id: string, userId: string): Promise<Cluster> {
    const cluster = await this.clusterRepo.findOne({ where: { id, userId } });
    if (!cluster) throw new BadRequestException('Cluster not found!');
    return this.decryptCluster(cluster);
  }

  // Internal use only — returns full decrypted credentials for DB connections
  private async findClusterForConnection(
    id: string,
    userId: string,
  ): Promise<Cluster> {
    const cluster = await this.clusterRepo.findOne({ where: { id, userId } });
    if (!cluster) throw new BadRequestException('Cluster not found!');
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
          multipleStatements: true,
        });
        await connection.end();
        return { success: true, message: 'MySQL connection successful!' };
      } catch (error) {
        throw new BadRequestException(
          `MySQL connection failed: ${error.message}`,
        );
      }
    } else if (type === ClusterType.POSTGRES) {
      const client = new Client({
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
    } else if (type === ClusterType.MSSQL) {
      try {
        const pool = await mssql.connect({
          server: host,
          port: port || 1433,
          user: username,
          password,
          database,
          options: { encrypt: true, trustServerCertificate: true },
          connectionTimeout: 5000,
        });
        await pool.close();
        return { success: true, message: 'MSSQL connection successful!' };
      } catch (error) {
        throw new BadRequestException(
          `MSSQL connection failed: ${error.message}`,
        );
      }
    }
    throw new BadRequestException('Invalid database type!');
  }

  async create(userId: string, createClusterDto: CreateClusterDto) {
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
    const cluster = await this.findClusterForConnection(id, userId);
    const { type, database } = cluster;

    if (type === ClusterType.MYSQL) {
      const pool = this.getMySQLPool(cluster);
      const [rows]: [any[], any] = await pool.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = ? ORDER BY table_name ASC',
        [database, 'BASE TABLE'],
      );
      return rows.map((row: any) => ({
        name: row.TABLE_NAME || row.table_name,
      }));
    } else if (type === ClusterType.POSTGRES) {
      const pool = this.getPGPool(cluster);
      const res = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name ASC",
      );
      return res.rows.map((row: any) => ({ name: row.table_name }));
    } else if (type === ClusterType.MSSQL) {
      const pool = await this.getMSSQLPool(cluster);
      const result = await pool.request().query(`
        SELECT TABLE_NAME as name FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_CATALOG = '${database}'
        ORDER BY TABLE_NAME ASC
      `);
      return result.recordset;
    }
  }

  private async validateTableExists(cluster: Cluster, tableName: string) {
    const { type, database } = cluster;
    if (type === ClusterType.MYSQL) {
      const pool = this.getMySQLPool(cluster);
      const [rows]: [any[], any] = await pool.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
        [database, tableName],
      );
      if (rows.length === 0)
        throw new BadRequestException(`Table '${tableName}' not found!`);
    } else if (type === ClusterType.POSTGRES) {
      const pool = this.getPGPool(cluster);
      const res = await pool.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)",
        [tableName],
      );
      if (!res.rows[0].exists)
        throw new BadRequestException(`Table '${tableName}' not found!`);
    } else if (type === ClusterType.MSSQL) {
      const pool = await this.getMSSQLPool(cluster);
      const result = await pool
        .request()
        .input('tableName', mssql.VarChar, tableName)
        .input('database', mssql.VarChar, database)
        .query(
          'SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = @tableName AND TABLE_CATALOG = @database',
        );
      if (result.recordset.length === 0)
        throw new BadRequestException(`Table '${tableName}' not found!`);
    }
  }

  async findTableColumns(id: string, userId: string, tableName: string) {
    const cluster = await this.findClusterForConnection(id, userId);
    const { type, database } = cluster;
    await this.validateTableExists(cluster, tableName);

    if (type === ClusterType.MYSQL) {
      const [rows]: [any[], any] = await this.getMySQLPool(cluster).query(
        `SELECT cols.COLUMN_NAME as name, cols.DATA_TYPE as type, cols.COLUMN_TYPE as fullType, cols.IS_NULLABLE as nullable, cols.COLUMN_DEFAULT as defaultValue, cols.COLUMN_KEY as columnKey, fk.referencedTable, fk.referencedColumn
         FROM information_schema.columns cols
         LEFT JOIN (SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME as referencedTable, REFERENCED_COLUMN_NAME as referencedColumn FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL GROUP BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME) fk 
         ON cols.TABLE_SCHEMA = fk.TABLE_SCHEMA AND cols.TABLE_NAME = fk.TABLE_NAME AND cols.COLUMN_NAME = fk.COLUMN_NAME
         WHERE cols.table_schema = ? AND cols.table_name = ? ORDER BY cols.ORDINAL_POSITION`,
        [database, tableName],
      );
      return rows;
    } else if (type === ClusterType.POSTGRES) {
      const res = await this.getPGPool(cluster).query(
        `SELECT DISTINCT ON (cols.ordinal_position) cols.column_name as name, cols.data_type as type, cols.is_nullable as nullable, cols.column_default as "defaultValue", cols.udt_name as "udtName", (SELECT string_agg(enumlabel, ',') FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid WHERE pg_type.typname = cols.udt_name) as "enumValues", kcu.referenced_table_name as "referencedTable", kcu.referenced_column_name as "referencedColumn"
         FROM information_schema.columns cols
         LEFT JOIN (SELECT kcu.table_name, kcu.column_name, ccu.table_name AS referenced_table_name, ccu.column_name AS referenced_column_name FROM information_schema.key_column_usage kcu JOIN information_schema.table_constraints tc ON kcu.constraint_name = tc.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY') kcu 
         ON cols.table_name = kcu.table_name AND cols.column_name = kcu.column_name
         WHERE cols.table_schema = 'public' AND cols.table_name = $1 ORDER BY cols.ordinal_position`,
        [tableName],
      );
      return res.rows;
    } else if (type === ClusterType.MSSQL) {
      const pool = await this.getMSSQLPool(cluster);
      const result = await pool
        .request()
        .input('tableName', mssql.VarChar, tableName)
        .input('database', mssql.VarChar, database)
        .query(`SELECT cols.COLUMN_NAME as name, cols.DATA_TYPE as type, cols.IS_NULLABLE as nullable, cols.COLUMN_DEFAULT as defaultValue, fk.referencedTable, fk.referencedColumn
                FROM INFORMATION_SCHEMA.COLUMNS cols
                LEFT JOIN (SELECT fk.name AS constraint_name, OBJECT_NAME(fk.parent_object_id) AS TABLE_NAME, col.name AS COLUMN_NAME, OBJECT_NAME(fk.referenced_object_id) AS referencedTable, ref_col.name AS referencedColumn FROM sys.foreign_keys AS fk INNER JOIN sys.foreign_key_columns AS fkc ON fk.object_id = fkc.constraint_object_id INNER JOIN sys.columns AS col ON fkc.parent_object_id = col.object_id AND fkc.parent_column_id = col.column_id INNER JOIN sys.columns AS ref_col ON fkc.referenced_object_id = ref_col.object_id AND fkc.referenced_column_id = ref_col.column_id) fk 
                ON cols.TABLE_NAME = fk.TABLE_NAME AND cols.COLUMN_NAME = fk.COLUMN_NAME
                WHERE cols.TABLE_NAME = @tableName AND cols.TABLE_CATALOG = @database ORDER BY cols.ORDINAL_POSITION`);
      return result.recordset;
    }
  }

  async getSchema(id: string, userId: string) {
    const cluster = await this.findClusterForConnection(id, userId);
    const { type, database } = cluster;

    if (type === ClusterType.MYSQL) {
      const [rows]: [any[], any] = await this.getMySQLPool(cluster).query(
        `SELECT cols.TABLE_NAME as tableName, cols.COLUMN_NAME as name, cols.DATA_TYPE as type, cols.COLUMN_TYPE as fullType, cols.IS_NULLABLE as nullable, cols.COLUMN_DEFAULT as defaultValue, cols.COLUMN_KEY as columnKey, fk.referencedTable, fk.referencedColumn
         FROM information_schema.columns cols
         LEFT JOIN (SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME as referencedTable, REFERENCED_COLUMN_NAME as referencedColumn FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL GROUP BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME) fk 
         ON cols.TABLE_SCHEMA = fk.TABLE_SCHEMA AND cols.TABLE_NAME = fk.TABLE_NAME AND cols.COLUMN_NAME = fk.COLUMN_NAME
         WHERE cols.table_schema = ?`,
        [database],
      );
      return rows;
    } else if (type === ClusterType.POSTGRES) {
      const res = await this.getPGPool(cluster).query(
        `SELECT DISTINCT ON (cols.table_name, cols.ordinal_position) cols.table_name as "tableName", cols.column_name as name, cols.data_type as type, cols.is_nullable as nullable, cols.column_default as "defaultValue", cols.udt_name as "udtName", kcu.referenced_table_name as "referencedTable", kcu.referenced_column_name as "referencedColumn"
         FROM information_schema.columns cols
         LEFT JOIN (SELECT kcu.table_name, kcu.column_name, ccu.table_name AS referenced_table_name, ccu.column_name AS referenced_column_name FROM information_schema.key_column_usage kcu JOIN information_schema.table_constraints tc ON kcu.constraint_name = tc.constraint_name JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY') kcu 
         ON cols.table_name = kcu.table_name AND cols.column_name = kcu.column_name
         WHERE cols.table_schema = 'public' ORDER BY cols.table_name, cols.ordinal_position`,
      );
      return res.rows;
    } else if (type === ClusterType.MSSQL) {
      const pool = await this.getMSSQLPool(cluster);
      const result = await pool
        .request()
        .input('database', mssql.VarChar, database)
        .query(`SELECT cols.TABLE_NAME as tableName, cols.COLUMN_NAME as name, cols.DATA_TYPE as type, cols.IS_NULLABLE as nullable, cols.COLUMN_DEFAULT as defaultValue, fk.referencedTable, fk.referencedColumn
                FROM INFORMATION_SCHEMA.COLUMNS cols
                LEFT JOIN (SELECT fk.name AS constraint_name, OBJECT_NAME(fk.parent_object_id) AS TABLE_NAME, col.name AS COLUMN_NAME, OBJECT_NAME(fk.referenced_object_id) AS referencedTable, ref_col.name AS referencedColumn FROM sys.foreign_keys AS fk INNER JOIN sys.foreign_key_columns AS fkc ON fk.object_id = fkc.constraint_object_id INNER JOIN sys.columns AS col ON fkc.parent_object_id = col.object_id AND fkc.parent_column_id = col.column_id INNER JOIN sys.columns AS ref_col ON fkc.referenced_object_id = ref_col.object_id AND fkc.referenced_column_id = ref_col.column_id) fk 
                ON cols.TABLE_NAME = fk.TABLE_NAME AND cols.COLUMN_NAME = fk.COLUMN_NAME
                WHERE cols.TABLE_CATALOG = @database ORDER BY cols.TABLE_NAME, cols.ORDINAL_POSITION`);
      return result.recordset;
    }
  }

  async findTableData(
    id: string,
    userId: string,
    tableName: string,
    page: number = 1,
    limit: number = 100,
    filters: any[] = [],
  ) {
    const cluster = await this.findClusterForConnection(id, userId);
    await this.validateTableExists(cluster, tableName);
    const offset = (page - 1) * limit;

    const buildWhere = (type: ClusterType, request?: mssql.Request) => {
      if (!filters || filters.length === 0) return { where: '', params: [] };
      const params: any[] = [];
      const clauses = filters.map((f, i) => {
        const { column, operator, value } = f;
        let op = '';
        let val = value;
        const col =
          type === ClusterType.MYSQL ? `\`${column}\`` : `"${column}"`;

        switch (operator) {
          case 'is':
            op = '=';
            break;
          case 'is_not':
            op = '!=';
            break;
          case 'contains':
            op = 'LIKE';
            val = `%${value}%`;
            break;
          case 'not_contains':
            op = 'NOT LIKE';
            val = `%${value}%`;
            break;
          case 'starts_with':
            op = 'LIKE';
            val = `${value}%`;
            break;
          case 'ends_with':
            op = 'LIKE';
            val = `%${value}`;
            break;
          case 'gt':
            op = '>';
            break;
          case 'lt':
            op = '<';
            break;
          case 'is_null':
            return `${col} IS NULL`;
          case 'is_not_null':
            return `${col} IS NOT NULL`;
          default:
            op = '=';
        }

        if (type === ClusterType.MSSQL && request) {
          request.input(`f${i}`, val);
          return `${col} ${op} @f${i}`;
        } else if (type === ClusterType.POSTGRES) {
          params.push(val);
          return `${col} ${op} $${params.length}`;
        } else {
          params.push(val);
          return `${col} ${op} ?`;
        }
      });

      return { where: ' WHERE ' + clauses.join(' AND '), params };
    };

    if (cluster.type === ClusterType.MYSQL) {
      const { where, params } = buildWhere(ClusterType.MYSQL);
      const [rows] = await this.getMySQLPool(cluster).query(
        `SELECT * FROM \`${tableName}\`${where} LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)],
      );
      const [count] = await this.getMySQLPool(cluster).query(
        `SELECT COUNT(*) as total FROM \`${tableName}\`${where}`,
        params,
      );
      return { data: rows, total: (count as any)[0].total, page, limit };
    } else if (cluster.type === ClusterType.POSTGRES) {
      const { where, params } = buildWhere(ClusterType.POSTGRES);
      const res = await this.getPGPool(cluster).query(
        `SELECT * FROM "${tableName}"${where} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      );
      const count = await this.getPGPool(cluster).query(
        `SELECT COUNT(*) as total FROM "${tableName}"${where}`,
        params,
      );
      return {
        data: res.rows,
        total: parseInt((count.rows[0] as any).total),
        page,
        limit,
      };
    } else if (cluster.type === ClusterType.MSSQL) {
      const pool = await this.getMSSQLPool(cluster);
      const request = pool.request();
      const { where } = buildWhere(ClusterType.MSSQL, request);
      request.input('offset', mssql.Int, offset);
      request.input('limit', mssql.Int, limit);
      const result = await request.query(
        `SELECT * FROM "${tableName}"${where} ORDER BY (SELECT NULL) OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY; SELECT COUNT(*) as total FROM "${tableName}"${where};`,
      );
      const recordsets = result.recordsets as any;
      return {
        data: recordsets[0],
        total: recordsets[1][0].total,
        page,
        limit,
      };
    }
  }

  async updateTableData(
    id: string,
    userId: string,
    tableName: string,
    data: any,
    where: any,
  ) {
    const cluster = await this.findClusterForConnection(id, userId);
    await this.validateTableExists(cluster, tableName);
    const { type } = cluster;

    if (type === ClusterType.MYSQL) {
      const set = Object.keys(data)
        .map((k) => `\`${k}\` = ?`)
        .join(', ');
      const cond = Object.keys(where)
        .map((k) => `\`${k}\` = ?`)
        .join(' AND ');
      const [result] = await this.getMySQLPool(cluster).query(
        `UPDATE \`${tableName}\` SET ${set} WHERE ${cond}`,
        [...Object.values(data), ...Object.values(where)],
      );
      return result;
    } else if (type === ClusterType.POSTGRES) {
      const set = Object.keys(data)
        .map((k, i) => `"${k}" = $${i + 1}`)
        .join(', ');
      const cond = Object.keys(where)
        .map((k, i) => `"${k}" = $${Object.keys(data).length + i + 1}`)
        .join(' AND ');
      const res = await this.getPGPool(cluster).query(
        `UPDATE "${tableName}" SET ${set} WHERE ${cond}`,
        [...Object.values(data), ...Object.values(where)],
      );
      return res.rowCount;
    } else if (type === ClusterType.MSSQL) {
      const pool = await this.getMSSQLPool(cluster);
      const req = pool.request();
      const set = Object.keys(data)
        .map((k, i) => {
          req.input(`v${i}`, data[k]);
          return `"${k}" = @v${i}`;
        })
        .join(', ');
      const cond = Object.keys(where)
        .map((k, i) => {
          req.input(`c${i}`, where[k]);
          return `"${k}" = @c${i}`;
        })
        .join(' AND ');
      const result = await req.query(
        `UPDATE "${tableName}" SET ${set} WHERE ${cond}`,
      );
      return result.rowsAffected[0];
    }
  }

  async insertTableData(
    id: string,
    userId: string,
    tableName: string,
    data: any,
  ) {
    const cluster = await this.findClusterForConnection(id, userId);
    await this.validateTableExists(cluster, tableName);
    const { type } = cluster;

    if (type === ClusterType.MYSQL) {
      const keys = Object.keys(data);
      const cols = keys.map((k) => `\`${k}\``).join(', ');
      const placeholders = keys.map(() => '?').join(', ');
      const [result] = await this.getMySQLPool(cluster).query(
        `INSERT INTO \`${tableName}\` (${cols}) VALUES (${placeholders})`,
        Object.values(data),
      );
      return result;
    } else if (type === ClusterType.POSTGRES) {
      const keys = Object.keys(data);
      const cols = keys.map((k) => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const res = await this.getPGPool(cluster).query(
        `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) RETURNING *`,
        Object.values(data),
      );
      return (res.rows as any)[0];
    } else if (type === ClusterType.MSSQL) {
      const pool = await this.getMSSQLPool(cluster);
      const req = pool.request();
      const cols = Object.keys(data)
        .map((k) => `"${k}"`)
        .join(', ');
      const placeholders = Object.keys(data)
        .map((k, i) => {
          req.input(`v${i}`, data[k]);
          return `@v${i}`;
        })
        .join(', ');
      const result = await req.query(
        `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}); SELECT SCOPE_IDENTITY() as id;`,
      );
      return result.recordset[0];
    }
  }

  async deleteTableData(
    id: string,
    userId: string,
    tableName: string,
    where: any,
  ) {
    const cluster = await this.findClusterForConnection(id, userId);
    await this.validateTableExists(cluster, tableName);
    const { type } = cluster;

    if (type === ClusterType.MYSQL) {
      const cond = Object.keys(where)
        .map((k) => `\`${k}\` = ?`)
        .join(' AND ');
      const [result] = await this.getMySQLPool(cluster).query(
        `DELETE FROM \`${tableName}\` WHERE ${cond}`,
        Object.values(where),
      );
      return result;
    } else if (type === ClusterType.POSTGRES) {
      const cond = Object.keys(where)
        .map((k, i) => `"${k}" = $${i + 1}`)
        .join(' AND ');
      const res = await this.getPGPool(cluster).query(
        `DELETE FROM "${tableName}" WHERE ${cond}`,
        Object.values(where),
      );
      return res.rowCount;
    } else if (type === ClusterType.MSSQL) {
      const pool = await this.getMSSQLPool(cluster);
      const req = pool.request();
      const cond = Object.keys(where)
        .map((k, i) => {
          req.input(`c${i}`, where[k]);
          return `"${k}" = @c${i}`;
        })
        .join(' AND ');
      const result = await req.query(
        `DELETE FROM "${tableName}" WHERE ${cond}`,
      );
      return result.rowsAffected[0];
    }
  }

  async executeQuery(
    id: string,
    userId: string,
    query: string,
    page?: number,
    limit?: number,
  ) {
    const cluster = await this.findClusterForConnection(id, userId);
    const startTime = Date.now();
    let success = true,
      errorMessage = null,
      results = null,
      totals: number[] = [];

    const isSelect = query.trim().toUpperCase().startsWith('SELECT');
    const isSingleQuery = !query.includes(';') || query.trim().endsWith(';');
    const usePagination = page && limit && isSelect && isSingleQuery;

    let execQuery = query;
    if (usePagination) {
      const offset = (page - 1) * limit;
      if (cluster.type === ClusterType.MSSQL) {
        execQuery = `SELECT * FROM (${query.replace(/;$/, '')}) AS __synq_sub ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
      } else {
        execQuery = `SELECT * FROM (${query.replace(/;$/, '')}) AS __synq_sub LIMIT ${limit} OFFSET ${offset}`;
      }
    }

    try {
      if (cluster.type === ClusterType.MYSQL) {
        const pool = this.getMySQLPool(cluster);
        const [rows] = await pool.query(execQuery);
        if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])) {
          results = rows;
        } else {
          results = [rows];
        }

        if (usePagination) {
          const [countRes]: any = await pool.query(
            `SELECT COUNT(*) as total FROM (${query.replace(/;$/, '')}) AS __synq_count`,
          );
          totals = [countRes[0].total];
        } else {
          totals = (results || []).map((r: any) =>
            Array.isArray(r) ? r.length : 0,
          );
        }
      } else if (cluster.type === ClusterType.POSTGRES) {
        const pool = this.getPGPool(cluster);
        const res = await pool.query(execQuery);
        if (Array.isArray(res)) {
          results = res.map((r) => r.rows || []);
        } else {
          results = [res.rows || []];
        }

        if (usePagination) {
          const countRes = await pool.query(
            `SELECT COUNT(*) as total FROM (${query.replace(/;$/, '')}) AS __synq_count`,
          );
          totals = [parseInt(countRes.rows[0].total)];
        } else {
          totals = (results || []).map((r: any) =>
            Array.isArray(r) ? r.length : 0,
          );
        }
      } else if (cluster.type === ClusterType.MSSQL) {
        const pool = await this.getMSSQLPool(cluster);
        const result = await pool.request().query(execQuery);
        results =
          Array.isArray(result.recordsets) && result.recordsets.length > 0
            ? result.recordsets
            : [result.recordset];

        if (usePagination) {
          const countRes = await pool
            .request()
            .query(
              `SELECT COUNT(*) as total FROM (${query.replace(/;$/, '')}) AS __synq_count`,
            );
          totals = [countRes.recordset[0].total];
        } else {
          totals = (results || []).map((r: any) =>
            Array.isArray(r) ? r.length : 0,
          );
        }
      }
    }
 catch (error) {
      success = false;
      errorMessage = error.message;
      throw new BadRequestException(error.message);
    } finally {
      await this.queryLogRepo.save({
        query,
        clusterId: id,
        userId,
        executionTimeMs: Date.now() - startTime,
        success,
        errorMessage,
      });
    }
    return { results, totals, executionTimeMs: Date.now() - startTime };
  }

  async getQueryLogs(clusterId: string, userId: string) {
    return this.queryLogRepo.find({
      where: { clusterId, userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  async remove(id: string, userId: string) {
    const cluster = await this.findClusterForConnection(id, userId);
    await this.clusterRepo.remove(cluster);
  }

  async dropTable(clusterId: string, userId: string, tableName: string) {
    const cluster = await this.clusterRepo.findOne({
      where: { id: clusterId, user: { id: userId } },
    });
    if (!cluster) throw new Error('Cluster not found');

    let sql = '';
    if (cluster.type === ClusterType.MYSQL) {
      sql = `DROP TABLE IF EXISTS \`${tableName}\`;`;
    } else if (cluster.type === ClusterType.POSTGRES) {
      sql = `DROP TABLE IF EXISTS "${tableName}" CASCADE;`;
    }

    try {
      await this.executeQuery(clusterId, userId, sql);
      return { success: true };
    } catch (error) {
      throw new Error(`Failed to drop table: ${error.message}`);
    }
  }

  async compareSchemas(sourceId: string, targetId: string, userId: string) {
    const sourceSchema = await this.getSchema(sourceId, userId);
    const targetSchema = await this.getSchema(targetId, userId);

    const sourceTables = this.groupByTable(sourceSchema);
    const targetTables = this.groupByTable(targetSchema);

    const diffs: {
      missingInTarget: any[];
      missingInSource: any[];
      tableMismatches: any[];
      matchingTables: any[];
    } = {
      missingInTarget: [],
      missingInSource: [],
      tableMismatches: [],
      matchingTables: [],
    };

    for (const tableName of Object.keys(sourceTables)) {
      if (!targetTables[tableName]) {
        diffs.missingInTarget.push({
          tableName,
          columns: sourceTables[tableName],
        });
      } else {
        const tableDiff = this.compareTableColumns(
          tableName,
          sourceTables[tableName],
          targetTables[tableName],
        );
        if (tableDiff.hasDiff) {
          diffs.tableMismatches.push(tableDiff);
        } else {
          diffs.matchingTables.push({
            tableName,
            columns: sourceTables[tableName],
          });
        }
      }
    }

    for (const tableName of Object.keys(targetTables)) {
      if (!sourceTables[tableName]) {
        diffs.missingInSource.push({
          tableName,
          columns: targetTables[tableName],
        });
      }
    }

    return diffs;
  }

  private groupByTable(schema: any[]) {
    const tables: Record<string, any[]> = {};
    schema.forEach((col) => {
      const t = col.tableName || col.table_name;
      if (!tables[t]) tables[t] = [];
      tables[t].push(col);
    });
    return tables;
  }

  private compareTableColumns(
    tableName: string,
    sourceCols: any[],
    targetCols: any[],
  ) {
    const diff: any = {
      tableName,
      hasDiff: false,
      missingColumns: [],
      typeMismatches: [],
    };

    const sourceColMap = new Map(sourceCols.map((c) => [c.name, c]));
    const targetColMap = new Map(targetCols.map((c) => [c.name, c]));

    sourceColMap.forEach((sCol, name) => {
      const tCol = targetColMap.get(name);
      if (!tCol) {
        diff.missingColumns.push({ ...sCol, status: 'missing_in_target' });
        diff.hasDiff = true;
      } else if (
        sCol.type.toLowerCase().trim() !== tCol.type.toLowerCase().trim()
      ) {
        diff.typeMismatches.push({
          name,
          sourceType: sCol.type,
          targetType: tCol.type,
        });
        diff.hasDiff = true;
      }
    });

    targetColMap.forEach((tCol, name) => {
      if (!sourceColMap.has(name)) {
        diff.missingColumns.push({ ...tCol, status: 'missing_in_source' });
        diff.hasDiff = true;
      }
    });

    return diff;
  }

  async syncSchema(
    sourceId: string,
    targetId: string,
    userId: string,
    tableNames: string[],
    withData: boolean = false,
  ) {
    const sourceSchema = await this.getSchema(sourceId, userId);
    const targetCluster = await this.findClusterForConnection(targetId, userId);
    const sourceTables = this.groupByTable(sourceSchema);

    const syncResults = [];

    for (const tableName of tableNames) {
      const columns = sourceTables[tableName];
      if (!columns) continue;

      let ddl = '';
      let dropDdl = '';
      if (targetCluster.type === ClusterType.MYSQL) {
        dropDdl = `DROP TABLE IF EXISTS \`${tableName}\`;`;
        ddl = this.generateMySQLCreateTable(tableName, columns);
      } else if (targetCluster.type === ClusterType.POSTGRES) {
        dropDdl = `DROP TABLE IF EXISTS "${tableName}" CASCADE;`;
        ddl = this.generatePostgresCreateTable(tableName, columns);
      }

      let success = true;
      let error = null;

      if (ddl) {
        try {
          if (dropDdl) await this.executeQuery(targetId, userId, dropDdl);
          await this.executeQuery(targetId, userId, ddl);

          if (withData) {
            const sourceData = await this.findTableData(
              sourceId,
              userId,
              tableName,
              1,
              1000,
            );
            if (sourceData && sourceData.data) {
              for (const row of sourceData.data) {
                await this.insertTableData(targetId, userId, tableName, row);
              }
            }
          }
        } catch (e) {
          success = false;
          error = e.message;
        }
      }

      syncResults.push({ tableName, success, error });
    }

    return syncResults;
  }

  private generateMySQLCreateTable(tableName: string, columns: any[]) {
    const colStrings = columns.map((c) => {
      let s = `\`${c.name}\` ${c.fullType || c.type}`;
      if (c.nullable === 'NO') s += ' NOT NULL';

      if (c.defaultValue !== null && c.defaultValue !== undefined) {
        const def = String(c.defaultValue).trim();
        const upperDef = def.toUpperCase();

        if (upperDef === 'NULL') {
          s += ' DEFAULT NULL';
        } else if (
          upperDef === 'CURRENT_TIMESTAMP' ||
          upperDef.includes('(') ||
          upperDef.includes(')')
        ) {
          s += ` DEFAULT ${def}`;
        } else if (
          (def.startsWith("'") && def.endsWith("'")) ||
          !isNaN(Number(def))
        ) {
          s += ` DEFAULT ${def}`;
        } else {
          s += ` DEFAULT '${def.replace(/'/g, "''")}'`;
        }
      }

      if (c.columnKey === 'PRI' || c.isPrimary) s += ' PRIMARY KEY';
      return s;
    });

    return `CREATE TABLE \`${tableName}\` (\n  ${colStrings.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;
  }

  private generatePostgresCreateTable(tableName: string, columns: any[]) {
    const colStrings = columns.map((c) => {
      let type = c.udtName || c.type;
      if (type === 'varchar') type = 'text';

      let s = `"${c.name}" ${type}`;
      if (c.nullable === 'NO') s += ' NOT NULL';

      if (c.defaultValue !== null && c.defaultValue !== undefined) {
        const def = String(c.defaultValue).trim();
        const upperDef = def.toUpperCase();

        if (upperDef === 'NULL') {
          s += ' DEFAULT NULL';
        } else if (
          !upperDef.includes('NEXTVAL') &&
          !upperDef.includes('(') &&
          !upperDef.includes(')')
        ) {
          if (!def.startsWith("'") && isNaN(Number(def))) {
            s += ` DEFAULT '${def.replace(/'/g, "''")}'`;
          } else {
            s += ` DEFAULT ${def}`;
          }
        } else if (!upperDef.includes('NEXTVAL')) {
          s += ` DEFAULT ${def}`;
        }
      }
      return s;
    });

    return `CREATE TABLE "${tableName}" (\n  ${colStrings.join(',\n  ')}\n);`;
  }

  async backup(id: string, userId: string, format: 'sql' | 'csv' | 'json') {
    const cluster = await this.findClusterForConnection(id, userId);
    const tables = await this.findTables(id, userId);
    const schema = await this.getSchema(id, userId);
    const tableSchemas = this.groupByTable(schema);

    const backupData: any = {};
    let sqlOutput = `-- SynqDB Backup\n-- Cluster: ${cluster.name}\n-- Date: ${new Date().toISOString()}\n\n`;

    for (const table of tables) {
      const tableName = table.name;
      const columns = tableSchemas[tableName];
      const data = await this.findTableData(id, userId, tableName, 1, 5000);

      if (format === 'sql') {
        let ddl = '';
        if (cluster.type === ClusterType.MYSQL) {
          ddl = this.generateMySQLCreateTable(tableName, columns);
        } else {
          ddl = this.generatePostgresCreateTable(tableName, columns);
        }
        sqlOutput += `${ddl}\n\n`;

        if (data && data.data.length > 0) {
          for (const row of data.data) {
            const keys = Object.keys(row);
            const cols = keys
              .map((k) =>
                cluster.type === ClusterType.MYSQL ? `\`${k}\`` : `"${k}"`,
              )
              .join(', ');
            const values = Object.values(row)
              .map((v) => {
                if (v === null) return 'NULL';
                if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
                if (v instanceof Date) return `'${v.toISOString()}'`;
                return v;
              })
              .join(', ');
            sqlOutput += `INSERT INTO ${cluster.type === ClusterType.MYSQL ? `\`${tableName}\`` : `"${tableName}"`} (${cols}) VALUES (${values});\n`;
          }
          sqlOutput += '\n';
        }
      } else if (format === 'json') {
        backupData[tableName] = data?.data || [];
      } else if (format === 'csv') {
        if (data && data.data && data.data.length > 0) {
          const headers = Object.keys(data.data[0]);
          const rows = data.data.map((row: any) =>
            headers
              .map((h) => {
                const val = row[h];
                if (val === null) return '';
                const str = String(val);
                return str.includes(',') || str.includes('"')
                  ? `"${str.replace(/"/g, '""')}"`
                  : str;
              })
              .join(','),
          );
          backupData[tableName] = [headers.join(','), ...rows].join('\n');
        } else {
          backupData[tableName] = '';
        }
      }
    }

    if (format === 'sql') return { content: sqlOutput };
    return backupData;
  }

  async restore(
    id: string,
    userId: string,
    format: 'sql' | 'csv' | 'json',
    data: any,
  ) {
    if (format === 'sql') {
      const queries = (data.content as string)
        .split(';')
        .map((q: string) => q.trim())
        .filter((q: string) => q.length > 0);
      for (const query of queries) {
        try {
          await this.executeQuery(id, userId, query);
        } catch (e) {
          console.error(`Failed to execute restore query: ${query}`, e);
        }
      }
      return { success: true };
    } else if (format === 'json') {
      for (const tableName of Object.keys(data)) {
        for (const row of data[tableName] as any[]) {
          await this.insertTableData(id, userId, tableName, row);
        }
      }
      return { success: true };
    } else if (format === 'csv') {
      // Simple CSV restore (assuming headers match)
      for (const tableName of Object.keys(data)) {
        const lines = (data[tableName] as string).split('\n');
        if (lines.length < 2) continue;
        const headers = lines[0].split(',');
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i]) continue;
          const values = lines[i].split(',');
          const row: Record<string, any> = {};
          headers.forEach((h: string, idx: number) => {
            row[h] = values[idx];
          });
          await this.insertTableData(id, userId, tableName, row);
        }
      }
      return { success: true };
    }
  }
}

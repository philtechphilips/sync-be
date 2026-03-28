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

import { UserOwnedService } from '../common/services/user-owned.service';

@Injectable()
export class ClustersService extends UserOwnedService<Cluster> {
  private mysqlPools = new Map<string, mysql.Pool>();
  private pgPools = new Map<string, any>();
  private mssqlPools = new Map<string, mssql.ConnectionPool>();

  constructor(
    @InjectRepository(Cluster)
    clusterRepo: Repository<Cluster>,
    @InjectRepository(QueryLog)
    private readonly queryLogRepo: Repository<QueryLog>,
    private readonly cryptographyService: CryptographyService,
  ) {
    super(clusterRepo, 'Cluster');
  }

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

  private async findClusterForConnection(id: string, userId: string) {
    return this.findOne(id, userId);
  }

  async findAll(userId: string): Promise<Cluster[]> {
    const clusters = await super.findAll(userId);
    return clusters.map((c) => this.decryptCluster(c));
  }

  async findOne(id: string, userId: string): Promise<Cluster> {
    const cluster = await super.findOne(id, userId);
    return this.decryptCluster(cluster);
  }

  async create(userId: string, createClusterDto: CreateClusterDto) {
    await this.testConnection(createClusterDto);
    const cluster = this.repository.create({
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
    const saved = await this.repository.save(cluster);
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
      const result = await pool
        .request()
        .input('database', mssql.VarChar, database).query(`
        SELECT TABLE_NAME as name FROM INFORMATION_SCHEMA.TABLES 
        WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_CATALOG = @database
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

  private escapeIdentifier(identifier: string, type: ClusterType): string {
    if (type === ClusterType.MYSQL) {
      return `\`${identifier.replaceAll('`', '``')}\``;
    } else {
      return `"${identifier.replaceAll('"', '""')}"`;
    }
  }

  private sanitizeType(type: string): string {
    // Column types are untrusted from source DB but should only contain safe characters
    // (alphanumeric, spaces, parentheses, commas for size/scale)
    return type.replaceAll(/[^a-zA-Z0-9\s(),]/g, '');
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
    const escapedTableName = this.escapeIdentifier(tableName, cluster.type);

    switch (cluster.type) {
      case ClusterType.MYSQL:
        return this.runFindMySQL(
          cluster,
          escapedTableName,
          filters,
          page,
          limit,
          offset,
        );
      case ClusterType.POSTGRES:
        return this.runFindPostgres(
          cluster,
          escapedTableName,
          filters,
          page,
          limit,
          offset,
        );
      case ClusterType.MSSQL:
        return this.runFindMSSQL(
          cluster,
          escapedTableName,
          filters,
          page,
          limit,
          offset,
        );
      default:
        throw new Error(`Unsupported cluster type: ${cluster.type}`);
    }
  }

  private async runFindMySQL(
    cluster: Cluster,
    escapedTableName: string,
    filters: any[],
    page: number,
    limit: number,
    offset: number,
  ) {
    const { where, params } = this.buildWhereClause(ClusterType.MYSQL, filters);
    const sql = ['SELECT * FROM', escapedTableName, where, 'LIMIT ? OFFSET ?']
      .filter(Boolean)
      .join(' ');

    const pool = this.getMySQLPool(cluster);
    const [rows] = await pool.query(sql, [
      ...params,
      Number(limit),
      Number(offset),
    ]);

    const countSql = ['SELECT COUNT(*) as total FROM', escapedTableName, where]
      .filter(Boolean)
      .join(' ');
    const [count]: any = await pool.query(countSql, params);
    return { data: rows, total: count[0].total, page, limit };
  }

  private async runFindPostgres(
    cluster: Cluster,
    escapedTableName: string,
    filters: any[],
    page: number,
    limit: number,
    offset: number,
  ) {
    const { where, params } = this.buildWhereClause(
      ClusterType.POSTGRES,
      filters,
    );
    const sql = [
      'SELECT * FROM',
      escapedTableName,
      where,
      `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    ]
      .filter(Boolean)
      .join(' ');

    const pool = this.getPGPool(cluster);
    const res = await pool.query(sql, [...params, limit, offset]);

    const countSql = ['SELECT COUNT(*) as total FROM', escapedTableName, where]
      .filter(Boolean)
      .join(' ');
    const count = await pool.query(countSql, params);
    return {
      data: res.rows,
      total: Number.parseInt(count.rows[0].total),
      page,
      limit,
    };
  }

  private async runFindMSSQL(
    cluster: Cluster,
    escapedTableName: string,
    filters: any[],
    page: number,
    limit: number,
    offset: number,
  ) {
    const pool = await this.getMSSQLPool(cluster);
    const request = pool.request();
    const { where } = this.buildWhereClause(
      ClusterType.MSSQL,
      filters,
      request,
    );
    request.input('offset', mssql.Int, offset);
    request.input('limit', mssql.Int, limit);

    const sql = [
      'SELECT * FROM',
      escapedTableName,
      where,
      'ORDER BY (SELECT NULL) OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;',
      'SELECT COUNT(*) as total FROM',
      escapedTableName,
      where + ';',
    ]
      .filter(Boolean)
      .join(' ');

    const result = await request.query(sql);
    const recordsets = result.recordsets as any;
    return {
      data: recordsets[0],
      total: recordsets[1][0].total,
      page,
      limit,
    };
  }

  private buildWhereClause(
    type: ClusterType,
    filters: any[],
    request?: mssql.Request,
  ) {
    if (!filters || filters.length === 0) return { where: '', params: [] };
    const params: any[] = [];
    const clauses = filters.map((f, i) => {
      const { column, operator, value } = f;
      let op = '';
      let val = value;
      const col = this.escapeIdentifier(column, type);

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
    const escapedTableName = this.escapeIdentifier(tableName, cluster.type);

    switch (cluster.type) {
      case ClusterType.MYSQL:
        return this.runUpdateMySQL(cluster, escapedTableName, data, where);
      case ClusterType.POSTGRES:
        return this.runUpdatePostgres(cluster, escapedTableName, data, where);
      case ClusterType.MSSQL:
        return this.runUpdateMSSQL(cluster, escapedTableName, data, where);
      default:
        throw new Error(`Unsupported cluster type: ${cluster.type}`);
    }
  }

  private async runUpdateMySQL(
    cluster: Cluster,
    escapedTableName: string,
    data: any,
    where: any,
  ) {
    const set = Object.keys(data)
      .map((k) => `${this.escapeIdentifier(k, ClusterType.MYSQL)} = ?`)
      .join(', ');
    const cond = Object.keys(where)
      .map((k) => `${this.escapeIdentifier(k, ClusterType.MYSQL)} = ?`)
      .join(' AND ');
    const [result] = await this.getMySQLPool(cluster).query(
      `UPDATE ${escapedTableName} SET ${set} WHERE ${cond}`,
      [...Object.values(data), ...Object.values(where)],
    );
    return result;
  }

  private async runUpdatePostgres(
    cluster: Cluster,
    escapedTableName: string,
    data: any,
    where: any,
  ) {
    const set = Object.keys(data)
      .map(
        (k, i) =>
          `${this.escapeIdentifier(k, ClusterType.POSTGRES)} = $${i + 1}`,
      )
      .join(', ');
    const cond = Object.keys(where)
      .map(
        (k, i) =>
          `${this.escapeIdentifier(k, ClusterType.POSTGRES)} = $${Object.keys(data).length + i + 1}`,
      )
      .join(' AND ');
    const res = await this.getPGPool(cluster).query(
      `UPDATE ${escapedTableName} SET ${set} WHERE ${cond}`,
      [...Object.values(data), ...Object.values(where)],
    );
    return res.rowCount;
  }

  private async runUpdateMSSQL(
    cluster: Cluster,
    escapedTableName: string,
    data: any,
    where: any,
  ) {
    const pool = await this.getMSSQLPool(cluster);
    const req = pool.request();
    const set = Object.keys(data)
      .map((k, i) => {
        req.input(`v${i}`, data[k]);
        return `${this.escapeIdentifier(k, ClusterType.MSSQL)} = @v${i}`;
      })
      .join(', ');
    const cond = Object.keys(where)
      .map((k, i) => {
        req.input(`c${i}`, where[k]);
        return `${this.escapeIdentifier(k, ClusterType.MSSQL)} = @c${i}`;
      })
      .join(' AND ');
    const result = await req.query(
      `UPDATE ${escapedTableName} SET ${set} WHERE ${cond}`,
    );
    return result.rowsAffected[0];
  }

  async insertTableData(
    id: string,
    userId: string,
    tableName: string,
    data: any,
  ) {
    const cluster = await this.findClusterForConnection(id, userId);
    await this.validateTableExists(cluster, tableName);
    const escapedTableName = this.escapeIdentifier(tableName, cluster.type);

    switch (cluster.type) {
      case ClusterType.MYSQL:
        return this.runInsertMySQL(cluster, escapedTableName, data);
      case ClusterType.POSTGRES:
        return this.runInsertPostgres(cluster, escapedTableName, data);
      case ClusterType.MSSQL:
        return this.runInsertMSSQL(cluster, escapedTableName, data);
      default:
        throw new Error(`Unsupported cluster type: ${cluster.type}`);
    }
  }

  private async runInsertMySQL(
    cluster: Cluster,
    escapedTableName: string,
    data: any,
  ) {
    const keys = Object.keys(data);
    const cols = keys
      .map((k) => this.escapeIdentifier(k, ClusterType.MYSQL))
      .join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    const [result] = await this.getMySQLPool(cluster).query(
      `INSERT INTO ${escapedTableName} (${cols}) VALUES (${placeholders})`,
      Object.values(data),
    );
    return result;
  }

  private async runInsertPostgres(
    cluster: Cluster,
    escapedTableName: string,
    data: any,
  ) {
    const keys = Object.keys(data);
    const cols = keys
      .map((k) => this.escapeIdentifier(k, ClusterType.POSTGRES))
      .join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const res = await this.getPGPool(cluster).query(
      `INSERT INTO ${escapedTableName} (${cols}) VALUES (${placeholders}) RETURNING *`,
      Object.values(data),
    );
    return (res.rows as any)[0];
  }

  private async runInsertMSSQL(
    cluster: Cluster,
    escapedTableName: string,
    data: any,
  ) {
    const pool = await this.getMSSQLPool(cluster);
    const req = pool.request();
    const cols = Object.keys(data)
      .map((k) => this.escapeIdentifier(k, ClusterType.MSSQL))
      .join(', ');
    const placeholders = Object.keys(data)
      .map((k, i) => {
        req.input(`v${i}`, data[k]);
        return `@v${i}`;
      })
      .join(', ');
    const result = await req.query(
      `INSERT INTO ${escapedTableName} (${cols}) VALUES (${placeholders}); SELECT SCOPE_IDENTITY() as id;`,
    );
    return result.recordset[0];
  }

  async deleteTableData(
    id: string,
    userId: string,
    tableName: string,
    where: any,
  ) {
    const cluster = await this.findClusterForConnection(id, userId);
    await this.validateTableExists(cluster, tableName);
    const escapedTableName = this.escapeIdentifier(tableName, cluster.type);

    switch (cluster.type) {
      case ClusterType.MYSQL:
        return this.runDeleteMySQL(cluster, escapedTableName, where);
      case ClusterType.POSTGRES:
        return this.runDeletePostgres(cluster, escapedTableName, where);
      case ClusterType.MSSQL:
        return this.runDeleteMSSQL(cluster, escapedTableName, where);
      default:
        throw new Error(`Unsupported cluster type: ${cluster.type}`);
    }
  }

  private async runDeleteMySQL(
    cluster: Cluster,
    escapedTableName: string,
    where: any,
  ) {
    const cond = Object.keys(where)
      .map((k) => `${this.escapeIdentifier(k, ClusterType.MYSQL)} = ?`)
      .join(' AND ');
    const [result] = await this.getMySQLPool(cluster).query(
      `DELETE FROM ${escapedTableName} WHERE ${cond}`,
      Object.values(where),
    );
    return result;
  }

  private async runDeletePostgres(
    cluster: Cluster,
    escapedTableName: string,
    where: any,
  ) {
    const cond = Object.keys(where)
      .map(
        (k, i) =>
          `${this.escapeIdentifier(k, ClusterType.POSTGRES)} = $${i + 1}`,
      )
      .join(' AND ');
    const res = await this.getPGPool(cluster).query(
      `DELETE FROM ${escapedTableName} WHERE ${cond}`,
      Object.values(where),
    );
    return res.rowCount;
  }

  private async runDeleteMSSQL(
    cluster: Cluster,
    escapedTableName: string,
    where: any,
  ) {
    const pool = await this.getMSSQLPool(cluster);
    const req = pool.request();
    const cond = Object.keys(where)
      .map((k, i) => {
        req.input(`c${i}`, where[k]);
        return `${this.escapeIdentifier(k, ClusterType.MSSQL)} = @c${i}`;
      })
      .join(' AND ');
    const result = await req.query(
      `DELETE FROM ${escapedTableName} WHERE ${cond}`,
    );
    return result.rowsAffected[0];
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

    const { execQuery, usePagination, baseQuery } = this.prepareQueryParams(
      query,
      cluster,
      page,
      limit,
    );

    let success = true;
    let errorMessage = null;
    let results: any = null;
    let totals: number[] = [];

    try {
      const resp = await this.runDatabaseQuery(
        cluster,
        execQuery,
        usePagination,
        baseQuery,
      );
      results = resp.results;
      totals = resp.totals;
    } catch (error) {
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

  private prepareQueryParams(
    query: string,
    cluster: Cluster,
    page?: number,
    limit?: number,
  ) {
    const trimmedQuery = query.trim();
    // Use a non-backtracking method for removing trailing semicolons (prevents ReDoS)
    let end = trimmedQuery.length;
    while (end > 0 && trimmedQuery[end - 1] === ';') {
      end--;
    }
    const baseQuery = trimmedQuery.substring(0, end);
    const isSelect = baseQuery.toUpperCase().startsWith('SELECT');
    const isSingleQuery = !baseQuery.includes(';');
    const usePagination = !!(page && limit && isSelect && isSingleQuery);

    let execQuery = query;
    if (usePagination) {
      const offset = (page - 1) * limit;
      if (cluster.type === ClusterType.MSSQL) {
        execQuery = `SELECT * FROM (${baseQuery}) AS __synq_sub ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
      } else {
        execQuery = `SELECT * FROM (${baseQuery}) AS __synq_sub LIMIT ${limit} OFFSET ${offset}`;
      }
    }

    return { execQuery, usePagination, baseQuery };
  }

  private async runDatabaseQuery(
    cluster: Cluster,
    execQuery: string,
    usePagination: boolean,
    baseQuery: string,
  ): Promise<{ results: any; totals: number[] }> {
    switch (cluster.type) {
      case ClusterType.MYSQL:
        return this.runMySQL(cluster, execQuery, usePagination, baseQuery);
      case ClusterType.POSTGRES:
        return this.runPostgres(cluster, execQuery, usePagination, baseQuery);
      case ClusterType.MSSQL:
        return this.runMSSQL(cluster, execQuery, usePagination, baseQuery);
      default:
        throw new Error(`Unsupported cluster type: ${cluster.type}`);
    }
  }

  private async runMySQL(
    cluster: Cluster,
    execQuery: string,
    usePagination: boolean,
    baseQuery: string,
  ) {
    const pool = this.getMySQLPool(cluster);
    const [rows] = await pool.query(execQuery);
    const results =
      Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])
        ? rows
        : [rows];

    let totals = [];
    if (usePagination) {
      // We wrap the base query in a subquery to count the total matching rows.
      // Semicolons are stripped to ensure the base query is valid as a sub-command.
      const safeBaseQuery = baseQuery.trim().replace(/;$/, '');
      const [countRes]: any = await pool.query(
        `SELECT COUNT(*) as total FROM (${safeBaseQuery}) AS __synq_count`,
      );
      totals = [countRes[0].total];
    } else {
      totals = results.map((r: any) => (Array.isArray(r) ? r.length : 0));
    }
    return { results, totals };
  }

  private async runPostgres(
    cluster: Cluster,
    execQuery: string,
    usePagination: boolean,
    baseQuery: string,
  ) {
    const pool = this.getPGPool(cluster);
    const res = await pool.query(execQuery);
    const results = Array.isArray(res)
      ? res.map((r) => r.rows || [])
      : [res.rows || []];

    let totals = [];
    if (usePagination) {
      // Wrap base query in a subquery for total row count.
      const safeBaseQuery = baseQuery.trim().replace(/;$/, '');
      const countRes = await pool.query(
        `SELECT COUNT(*) as total FROM (${safeBaseQuery}) AS __synq_count`,
      );
      totals = [Number.parseInt(countRes.rows[0].total)];
    } else {
      totals = results.map((r: any) => (Array.isArray(r) ? r.length : 0));
    }
    return { results, totals };
  }

  private async runMSSQL(
    cluster: Cluster,
    execQuery: string,
    usePagination: boolean,
    baseQuery: string,
  ) {
    const pool = await this.getMSSQLPool(cluster);
    const result = await pool.request().query(execQuery);
    const results =
      Array.isArray(result.recordsets) && result.recordsets.length > 0
        ? result.recordsets
        : [result.recordset];

    let totals = [];
    if (usePagination) {
      const safeBaseQuery = baseQuery.trim().replace(/;$/, '');
      const countRes = await pool
        .request()
        .query(
          `SELECT COUNT(*) as total FROM (${safeBaseQuery}) AS __synq_count`,
        );
      totals = [countRes.recordset[0].total];
    } else {
      totals = results.map((r: any) => (Array.isArray(r) ? r.length : 0));
    }
    return { results, totals };
  }

  async getQueryLogs(clusterId: string, userId: string) {
    return this.queryLogRepo.find({
      where: { clusterId, userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  async remove(id: string, userId: string) {
    const cluster = await this.findOne(id, userId);
    await this.repository.remove(cluster);
  }

  async dropTable(clusterId: string, userId: string, tableName: string) {
    const cluster = await this.findOne(clusterId, userId);
    if (!cluster) throw new Error('Cluster not found');

    let sql = '';
    if (cluster.type === ClusterType.MYSQL) {
      sql = `DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName, ClusterType.MYSQL)};`;
    } else if (cluster.type === ClusterType.POSTGRES) {
      sql = `DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName, ClusterType.POSTGRES)} CASCADE;`;
    } else if (cluster.type === ClusterType.MSSQL) {
      sql = `DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName, ClusterType.MSSQL)};`;
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

      const result = await this.syncSingleTable(
        sourceId,
        targetId,
        userId,
        tableName,
        columns,
        targetCluster.type,
        withData,
      );
      syncResults.push(result);
    }

    return syncResults;
  }

  private async syncSingleTable(
    sourceId: string,
    targetId: string,
    userId: string,
    tableName: string,
    columns: any[],
    targetType: ClusterType,
    withData: boolean,
  ) {
    const { dropDdl, createDdl } = this.getSyncDDL(
      tableName,
      columns,
      targetType,
    );
    let success = true;
    let error = null;

    try {
      if (dropDdl) await this.executeQuery(targetId, userId, dropDdl);
      if (createDdl) await this.executeQuery(targetId, userId, createDdl);

      if (withData && createDdl) {
        await this.syncTableData(sourceId, targetId, userId, tableName);
      }
    } catch (e) {
      success = false;
      error = e.message;
    }

    return { tableName, success, error };
  }

  private getSyncDDL(
    tableName: string,
    columns: any[],
    targetType: ClusterType,
  ) {
    let dropDdl = '';
    let createDdl = '';

    if (targetType === ClusterType.MYSQL) {
      dropDdl = `DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName, ClusterType.MYSQL)};`;
      createDdl = this.generateMySQLCreateTable(tableName, columns);
    } else if (targetType === ClusterType.POSTGRES) {
      dropDdl = `DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName, ClusterType.POSTGRES)} CASCADE;`;
      createDdl = this.generatePostgresCreateTable(tableName, columns);
    }

    return { dropDdl, createDdl };
  }

  private async syncTableData(
    sourceId: string,
    targetId: string,
    userId: string,
    tableName: string,
  ) {
    const sourceData = await this.findTableData(
      sourceId,
      userId,
      tableName,
      1,
      1000,
    );
    if (!sourceData?.data) return;

    for (const row of sourceData.data) {
      await this.insertTableData(targetId, userId, tableName, row);
    }
  }

  private generateMySQLCreateTable(tableName: string, columns: any[]) {
    const colStrings = columns.map((c) => {
      const colParts = [
        this.escapeIdentifier(c.name, ClusterType.MYSQL),
        this.sanitizeType(c.fullType || c.type),
      ];

      if (c.nullable === 'NO') colParts.push('NOT NULL');

      if (c.defaultValue !== null && c.defaultValue !== undefined) {
        const def = String(c.defaultValue).trim();
        const upperDef = def.toUpperCase();

        if (upperDef === 'NULL') {
          colParts.push('DEFAULT NULL');
        } else if (
          upperDef === 'CURRENT_TIMESTAMP' ||
          upperDef.includes('(') ||
          upperDef.includes(')')
        ) {
          colParts.push(`DEFAULT ${def}`);
        } else if (
          (def.startsWith("'") && def.endsWith("'")) ||
          !isNaN(Number(def))
        ) {
          colParts.push(`DEFAULT ${def}`);
        } else {
          colParts.push(`DEFAULT '${def.replaceAll("'", "''")}'`);
        }
      }

      if (c.columnKey === 'PRI' || c.isPrimary) colParts.push('PRIMARY KEY');
      return colParts.join(' ');
    });

    return [
      'CREATE TABLE',
      this.escapeIdentifier(tableName, ClusterType.MYSQL),
      '(',
      colStrings.join(',\n  '),
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;',
    ].join(' ');
  }

  private generatePostgresCreateTable(tableName: string, columns: any[]) {
    const colStrings = columns.map((c) => {
      const type = this.sanitizeType(
        (c.udtName || c.type) === 'varchar' ? 'text' : c.udtName || c.type,
      );
      const colParts = [
        this.escapeIdentifier(c.name, ClusterType.POSTGRES),
        type,
      ];

      if (c.nullable === 'NO') colParts.push('NOT NULL');

      if (c.defaultValue !== null && c.defaultValue !== undefined) {
        const def = String(c.defaultValue).trim();
        const upperDef = def.toUpperCase();

        if (upperDef === 'NULL') {
          colParts.push('DEFAULT NULL');
        } else if (
          !upperDef.includes('NEXTVAL') &&
          !upperDef.includes('(') &&
          !upperDef.includes(')')
        ) {
          if (!def.startsWith("'") && isNaN(Number(def))) {
            colParts.push(`DEFAULT '${def.replaceAll("'", "''")}'`);
          } else {
            colParts.push(`DEFAULT ${def}`);
          }
        } else if (!upperDef.includes('NEXTVAL')) {
          colParts.push(`DEFAULT ${def}`);
        }
      }
      return colParts.join(' ');
    });

    return [
      'CREATE TABLE',
      this.escapeIdentifier(tableName, ClusterType.POSTGRES),
      '(',
      colStrings.join(',\n  '),
      ');',
    ].join(' ');
  }

  async backup(id: string, userId: string, format: 'sql' | 'csv' | 'json') {
    const cluster = await this.findClusterForConnection(id, userId);
    const tables = await this.findTables(id, userId);
    const schema = await this.getSchema(id, userId);
    const tableSchemas = this.groupByTable(schema);

    if (format === 'sql') {
      return {
        content: await this.generateSQLBackup(
          id,
          userId,
          cluster,
          tables,
          tableSchemas,
        ),
      };
    }

    const backupData: any = {};
    for (const table of tables) {
      const data = await this.findTableData(id, userId, table.name, 1, 5000);
      if (format === 'json') {
        backupData[table.name] = data?.data || [];
      } else if (format === 'csv') {
        backupData[table.name] = this.formatCSVData(data?.data || []);
      }
    }

    return backupData;
  }

  private async generateSQLBackup(
    id: string,
    userId: string,
    cluster: Cluster,
    tables: any[],
    tableSchemas: any,
  ) {
    let sql = `-- SynqDB Backup\n-- Cluster: ${cluster.name}\n-- Date: ${new Date().toISOString()}\n\n`;

    for (const table of tables) {
      const columns = tableSchemas[table.name];
      const data = await this.findTableData(id, userId, table.name, 1, 5000);

      const ddl =
        cluster.type === ClusterType.MYSQL
          ? this.generateMySQLCreateTable(table.name, columns)
          : this.generatePostgresCreateTable(table.name, columns);

      sql += `${ddl}\n\n`;

      if (data?.data?.length > 0) {
        sql += this.formatSQLInsert(table.name, data.data, cluster.type);
        sql += '\n';
      }
    }
    return sql;
  }

  private formatSQLInsert(tableName: string, rows: any[], type: ClusterType) {
    return rows
      .map((row) => {
        const keys = Object.keys(row);
        const cols = keys.map((k) => this.escapeIdentifier(k, type)).join(', ');
        const values = Object.values(row)
          .map((v) => {
            if (v === null) return 'NULL';
            if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`;
            if (v instanceof Date) return `'${v.toISOString()}'`;
            return v;
          })
          .join(', ');
        return `INSERT INTO ${this.escapeIdentifier(tableName, type)} (${cols}) VALUES (${values});`;
      })
      .join('\n');
  }

  private formatCSVData(data: any[]) {
    if (!data || data.length === 0) return '';
    const headers = Object.keys(data[0]);
    const rows = data.map((row: any) =>
      headers
        .map((h) => {
          const val = row[h];
          if (val === null) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"')
            ? `"${str.replaceAll('"', '""')}"`
            : str;
        })
        .join(','),
    );
    return [headers.join(','), ...rows].join('\n');
  }

  async restore(
    id: string,
    userId: string,
    format: 'sql' | 'csv' | 'json',
    data: any,
  ) {
    if (format === 'sql') return this.restoreSQL(id, userId, data.content);
    if (format === 'json') return this.restoreJSON(id, userId, data);
    if (format === 'csv') return this.restoreCSV(id, userId, data);
  }

  private async restoreSQL(id: string, userId: string, content: string) {
    const queries = content
      .split(';')
      .map((q) => q.trim())
      .filter((q) => q.length > 0);

    for (const query of queries) {
      try {
        await this.executeQuery(id, userId, query);
      } catch (e) {
        console.error(`Failed to execute restore query: ${query}`, e);
      }
    }
    return { success: true };
  }

  private async restoreJSON(id: string, userId: string, data: any) {
    for (const tableName of Object.keys(data)) {
      for (const row of data[tableName] as any[]) {
        await this.insertTableData(id, userId, tableName, row);
      }
    }
    return { success: true };
  }

  private async restoreCSV(id: string, userId: string, data: any) {
    for (const tableName of Object.keys(data)) {
      const lines = (data[tableName] as string).split('\n');
      if (lines.length < 2) continue;

      const headers = lines[0].split(',');
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const row = this.parseCSVRow(headers, lines[i]);
        await this.insertTableData(id, userId, tableName, row);
      }
    }
    return { success: true };
  }

  private parseCSVRow(headers: string[], line: string) {
    const values = line.split(',');
    const row: Record<string, any> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx];
    });
    return row;
  }
}

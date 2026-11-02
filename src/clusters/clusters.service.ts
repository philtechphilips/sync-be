import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cluster, ClusterType } from './entities/cluster.entity';
import { QueryLog } from './entities/query-log.entity';
import { User } from '../auth/entities/user.entity';
import { CreateClusterDto, UpdateClusterDto } from './dto/create-cluster.dto';
import { CryptographyService } from '../common/services/cryptography.service';
import { UserOwnedService } from '../common/services/user-owned.service';
import { DbExecutor } from './engine/executor';
import { Dialect, dialectFor, matchKey, tableRef } from './engine/dialects';
import { coerceValue, toText } from './engine/values';
import {
  findDestructiveStatements,
  isSingleRowQuery,
} from './engine/sql-splitter';
import {
  ColumnInfo,
  ConnectionTarget,
  ForeignKeyInfo,
  IndexInfo,
  Row,
  ValueKind,
} from './engine/types';

const SENSITIVE_FIELDS = [
  'name',
  'host',
  'username',
  'password',
  'database',
] as const;
const CONNECTION_FIELDS = [
  'type',
  'host',
  'port',
  'username',
  'password',
  'database',
  'sslMode',
  'isLocal',
  'agentConnection',
] as const;
const ENCRYPTED_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/i;
const MAX_PAGE_SIZE = 50_000;

export interface Filter {
  column: string;
  operator: string;
  value?: unknown;
}

interface Clause {
  sql: string;
  params: unknown[];
  kinds: (ValueKind | null)[];
}

@Injectable()
export class ClustersService extends UserOwnedService<Cluster> {
  constructor(
    @InjectRepository(Cluster)
    clusterRepo: Repository<Cluster>,
    @InjectRepository(QueryLog)
    private readonly queryLogRepo: Repository<QueryLog>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly cryptographyService: CryptographyService,
    private readonly executor: DbExecutor,
  ) {
    super(clusterRepo, 'Cluster');
  }

  // ─── Credentials ─────────────────────────────────────────────────────────

  /** Returns a decrypted copy; the entity loaded from the DB is never mutated. */
  private decrypted(cluster: Cluster): Cluster {
    const copy = this.repository.create({ ...cluster });
    for (const field of SENSITIVE_FIELDS) {
      const value = cluster[field];
      if (typeof value === 'string' && ENCRYPTED_RE.test(value)) {
        try {
          copy[field] = this.cryptographyService.decrypt(value);
        } catch {
          throw new BadRequestException(
            'Failed to unlock cluster credentials. Check DB_ENCRYPTION_KEY.',
          );
        }
      }
    }
    return copy;
  }

  private encryptFields(
    values: Partial<Record<(typeof SENSITIVE_FIELDS)[number], unknown>>,
  ) {
    const out: Record<string, string | null> = {};
    for (const field of SENSITIVE_FIELDS) {
      const value = values[field];
      if (value === undefined) continue;
      out[field] =
        value === null || value === ''
          ? field === 'password'
            ? null
            : ''
          : this.cryptographyService.encrypt(toText(value));
    }
    return out;
  }

  /**
   * Loads the stored entity and re-encrypts any field that was saved in
   * plaintext (an earlier bug wrote decrypted values back on update).
   */
  private async findRaw(id: string, userId: string): Promise<Cluster> {
    const cluster = await super.findOne(id, userId);
    const plain: Partial<Record<(typeof SENSITIVE_FIELDS)[number], string>> =
      {};
    for (const field of SENSITIVE_FIELDS) {
      const value = cluster[field];
      if (
        typeof value === 'string' &&
        value !== '' &&
        !ENCRYPTED_RE.test(value)
      ) {
        plain[field] = value;
      }
    }
    if (Object.keys(plain).length > 0) {
      const fixed = this.encryptFields(plain);
      await this.repository.update({ id: cluster.id }, fixed as any);
      Object.assign(cluster, fixed);
    }
    return cluster;
  }

  private target(cluster: Cluster): ConnectionTarget {
    return {
      id: cluster.id,
      userId: cluster.userId,
      type: cluster.type,
      host: cluster.host,
      port: cluster.port,
      username: cluster.username ?? '',
      password: cluster.password ?? null,
      database: cluster.database ?? '',
      sslMode: cluster.sslMode ?? 'prefer',
      isLocal: !!cluster.isLocal,
      agentConnection: cluster.agentConnection ?? null,
    };
  }

  async connectionFor(id: string, userId: string) {
    const cluster = this.decrypted(await this.findRaw(id, userId));
    return {
      cluster,
      target: this.target(cluster),
      dialect: dialectFor(cluster.type),
    };
  }

  async findAll(userId: string): Promise<Cluster[]> {
    const clusters = await super.findAll(userId);
    return clusters.map((c) => this.decrypted(c));
  }

  async findOne(id: string, userId: string): Promise<Cluster> {
    return this.decrypted(await this.findRaw(id, userId));
  }

  private validateShape(dto: Partial<CreateClusterDto>) {
    if (dto.type === ClusterType.SQLITE && !dto.isLocal) {
      throw new BadRequestException(
        'SQLite files must be opened through the local agent. Enable "Local database".',
      );
    }
    if (dto.agentConnection && !dto.isLocal) {
      throw new BadRequestException(
        'Agent connections are only used by local clusters.',
      );
    }
    if (!dto.agentConnection && !(dto.host ?? '').trim()) {
      throw new BadRequestException('Host is required.');
    }
  }

  private toTarget(
    dto: Partial<CreateClusterDto>,
    userId: string,
    id = 'connection-test',
  ): ConnectionTarget {
    return {
      id,
      userId,
      type: dto.type!,
      host: (dto.host ?? '').trim(),
      port: dto.port ?? 0,
      username: dto.username ?? '',
      password: dto.password ?? null,
      database: dto.database ?? '',
      sslMode: dto.sslMode ?? 'prefer',
      isLocal: !!dto.isLocal,
      agentConnection: dto.agentConnection || null,
    };
  }

  /** Tests the connection; local clusters are tested only if the agent is online. */
  private async tryConnect(t: ConnectionTarget, requireAgent: boolean) {
    try {
      await this.executor.test(t);
    } catch (error) {
      if (
        t.isLocal &&
        !requireAgent &&
        /not connected/i.test((error as Error).message)
      ) {
        return;
      }
      throw new BadRequestException(
        `${t.type} connection failed: ${(error as Error).message}`,
      );
    }
  }

  async testConnection(dto: CreateClusterDto, userId: string) {
    this.validateShape(dto);
    await this.tryConnect(this.toTarget(dto, userId), true);
    return { success: true, message: 'Connection successful!' };
  }

  async create(userId: string, dto: CreateClusterDto) {
    this.validateShape(dto);
    await this.tryConnect(this.toTarget(dto, userId), false);
    // With an agent connection, the host and credentials stay on the agent.
    const viaAgent = !!dto.agentConnection;
    const cluster = this.repository.create({
      type: dto.type,
      environment: dto.environment,
      color: dto.color,
      port: viaAgent ? 0 : (dto.port ?? 0),
      isLocal: !!dto.isLocal,
      sslMode: dto.sslMode ?? 'prefer',
      agentConnection: dto.agentConnection || null,
      userId,
      ...(this.encryptFields({
        name: dto.name,
        host: viaAgent ? '' : dto.host?.trim(),
        username: viaAgent ? '' : (dto.username ?? ''),
        password: viaAgent ? null : dto.password,
        database: viaAgent ? '' : (dto.database ?? ''),
      }) as Partial<Cluster>),
    });
    const saved = await this.repository.save(cluster);
    return this.decrypted(saved);
  }

  async updateCluster(id: string, userId: string, dto: UpdateClusterDto) {
    const current = this.decrypted(await this.findRaw(id, userId));
    const updates: Partial<CreateClusterDto> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      if (key === 'password' && value === '') continue; // empty = keep current
      (updates as any)[key] = value;
    }
    if (updates.agentConnection) {
      // Moving to an agent connection: forget the credentials stored here.
      Object.assign(updates, {
        host: '',
        username: '',
        password: null,
        database: '',
        port: 0,
      });
    }
    const merged = { ...current, ...updates } as Partial<CreateClusterDto>;
    this.validateShape(merged);

    if (
      CONNECTION_FIELDS.some((f) => f in updates && updates[f] !== current[f])
    ) {
      await this.tryConnect(this.toTarget(merged, userId, id), false);
    }

    const { name, host, username, password, database, ...rest } = updates;
    await this.repository.update({ id, userId }, {
      ...rest,
      ...this.encryptFields({ name, host, username, password, database }),
    } as any);
    await this.executor.invalidate(id);
    return this.findOne(id, userId);
  }

  async remove(id: string, userId: string) {
    const cluster = await super.findOne(id, userId);
    await this.queryLogRepo.delete({ clusterId: id });
    await this.repository.remove(cluster);
    await this.executor.invalidate(id);
  }

  // ─── Metadata ────────────────────────────────────────────────────────────

  private async loadColumns(
    t: ConnectionTarget,
    dialect: Dialect,
    table?: string,
  ): Promise<ColumnInfo[]> {
    const stmt = dialect.columnsQuery(table);
    const { rows } = await this.executor.run(t, stmt.sql, stmt.params);
    return rows.map((r) => dialect.normalizeColumn(r));
  }

  async tableColumns(t: ConnectionTarget, dialect: Dialect, table: string) {
    if (typeof table !== 'string' || table === '') {
      throw new BadRequestException('Table name is required.');
    }
    const columns = await this.loadColumns(t, dialect, table);
    if (columns.length === 0)
      throw new NotFoundException(`Table '${table}' not found!`);
    return columns;
  }

  async schemaFor(t: ConnectionTarget, dialect: Dialect) {
    return this.loadColumns(t, dialect);
  }

  async indexesFor(
    t: ConnectionTarget,
    dialect: Dialect,
    table?: string,
  ): Promise<IndexInfo[]> {
    const stmt = dialect.indexesQuery(table);
    const { rows } = await this.executor.run(t, stmt.sql, stmt.params);
    return rows.map((r) => dialect.normalizeIndex(r));
  }

  async foreignKeysFor(
    t: ConnectionTarget,
    dialect: Dialect,
    table?: string,
  ): Promise<ForeignKeyInfo[]> {
    const stmt = dialect.foreignKeysQuery(table);
    const { rows } = await this.executor.run(t, stmt.sql, stmt.params);
    return rows.map((r) => dialect.normalizeForeignKey(r));
  }

  async findTables(id: string, userId: string) {
    const { target, dialect } = await this.connectionFor(id, userId);
    const stmt = dialect.tablesQuery();
    const { rows } = await this.executor.run(target, stmt.sql, stmt.params);
    return rows.map((r) => ({
      name: String(r.name ?? r.NAME ?? r.TABLE_NAME),
    }));
  }

  async findTableColumns(id: string, userId: string, tableName: string) {
    const { target, dialect } = await this.connectionFor(id, userId);
    return this.tableColumns(target, dialect, tableName);
  }

  async getSchema(id: string, userId: string) {
    const { target, dialect } = await this.connectionFor(id, userId);
    return this.schemaFor(target, dialect);
  }

  // ─── Row access ──────────────────────────────────────────────────────────

  private columnMap(columns: ColumnInfo[]) {
    return new Map(columns.map((c) => [c.name, c]));
  }

  private requireColumn(map: Map<string, ColumnInfo>, name: string) {
    const column = map.get(name);
    if (!column) throw new BadRequestException(`Unknown column "${name}".`);
    return column;
  }

  private buildFilters(
    t: ConnectionTarget,
    dialect: Dialect,
    columns: ColumnInfo[],
    filters: Filter[],
  ): Clause {
    const map = this.columnMap(columns);
    const clauses: string[] = [];
    const params: unknown[] = [];
    const kinds: (ValueKind | null)[] = [];
    const add = (value: unknown, kind: ValueKind | null) => {
      params.push(value);
      kinds.push(kind);
      return dialect.param(params.length);
    };

    for (const f of Array.isArray(filters) ? filters : []) {
      if (!f || typeof f !== 'object') continue;
      const column = this.requireColumn(map, String(f.column));
      const q = dialect.quote(column.name);
      const raw = f.value;
      switch (f.operator) {
        case 'is_null':
          clauses.push(`${q} IS NULL`);
          break;
        case 'is_not_null':
          clauses.push(`${q} IS NOT NULL`);
          break;
        case 'contains':
        case 'not_contains':
        case 'starts_with':
        case 'ends_with': {
          const s = toText(raw);
          const pattern =
            f.operator === 'starts_with'
              ? `${s}%`
              : f.operator === 'ends_with'
                ? `%${s}`
                : `%${s}%`;
          clauses.push(
            dialect.like(
              column,
              add(pattern, 'text'),
              f.operator === 'not_contains',
            ),
          );
          break;
        }
        case 'is':
        case 'is_not':
        case 'gt':
        case 'lt': {
          const value =
            column.kind === 'json'
              ? toText(raw)
              : coerceValue(t.type, column, raw);
          if (value === null) {
            if (f.operator === 'is') clauses.push(`${q} IS NULL`);
            else if (f.operator === 'is_not') clauses.push(`${q} IS NOT NULL`);
            else
              throw new BadRequestException(
                `A value is required to filter "${column.name}".`,
              );
            break;
          }
          const ph = add(value, column.kind);
          if (f.operator === 'is') clauses.push(dialect.equals(column, ph));
          else if (f.operator === 'is_not')
            clauses.push(`NOT (${dialect.equals(column, ph)})`);
          else clauses.push(`${q} ${f.operator === 'gt' ? '>' : '<'} ${ph}`);
          break;
        }
        default:
          throw new BadRequestException(
            `Unsupported filter operator "${String(f.operator)}".`,
          );
      }
    }
    return {
      sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '',
      params,
      kinds,
    };
  }

  /** WHERE for identifying rows; `coversKey` tells if it pins one row by PK. */
  private buildWhere(
    t: ConnectionTarget,
    dialect: Dialect,
    columns: ColumnInfo[],
    where: Record<string, unknown>,
    startAt: number,
  ): Clause & { coversKey: boolean } {
    if (
      !where ||
      typeof where !== 'object' ||
      Array.isArray(where) ||
      Object.keys(where).length === 0
    ) {
      throw new BadRequestException(
        'A non-empty "where" is required to identify the row.',
      );
    }
    const map = this.columnMap(columns);
    const clauses: string[] = [];
    const params: unknown[] = [];
    const kinds: (ValueKind | null)[] = [];
    for (const [name, raw] of Object.entries(where)) {
      const column = this.requireColumn(map, name);
      const value = coerceValue(t.type, column, raw);
      if (value === null) {
        clauses.push(dialect.equals(column, null));
      } else {
        params.push(value);
        kinds.push(column.kind);
        clauses.push(
          dialect.equals(column, dialect.param(startAt + params.length - 1)),
        );
      }
    }
    const pk = columns.filter((c) => c.columnKey === 'PRI');
    const coversKey =
      pk.length > 0 &&
      pk.every((c) => where[c.name] !== undefined && where[c.name] !== null);
    return { sql: clauses.join(' AND '), params, kinds, coversKey };
  }

  private buildValues(
    t: ConnectionTarget,
    columns: ColumnInfo[],
    data: Record<string, unknown>,
  ) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new BadRequestException('Row data must be an object.');
    }
    const map = this.columnMap(columns);
    const names: string[] = [];
    const params: unknown[] = [];
    const kinds: (ValueKind | null)[] = [];
    for (const [name, raw] of Object.entries(data)) {
      if (raw === undefined) continue;
      const column = this.requireColumn(map, name);
      if (column.isGenerated) {
        throw new BadRequestException(
          `Column "${name}" is generated and can't be set.`,
        );
      }
      names.push(name);
      params.push(coerceValue(t.type, column, raw));
      kinds.push(column.kind);
    }
    return { names, params, kinds };
  }

  async findTableData(
    id: string,
    userId: string,
    tableName: string,
    page = 1,
    limit = 100,
    filters: Filter[] = [],
  ) {
    const { target, dialect } = await this.connectionFor(id, userId);
    const columns = await this.tableColumns(target, dialect, tableName);
    const safePage = Math.max(1, Math.floor(Number(page) || 1));
    const safeLimit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(Number(limit) || 100)),
    );
    const where = this.buildFilters(target, dialect, columns, filters);
    const orderBy = columns
      .filter((c) => c.columnKey === 'PRI')
      .map((c) => dialect.quote(c.name))
      .join(', ');
    const table = dialect.qualify(tableRef(columns));
    const paging = dialect.pageClause({
      orderBy,
      limit: safeLimit,
      offset: (safePage - 1) * safeLimit,
    });

    const [data, count] = await Promise.all([
      this.executor.run(
        target,
        `SELECT ${dialect.selectList(columns)} FROM ${table}${where.sql}${paging}`,
        where.params,
        where.kinds,
      ),
      this.executor.run(
        target,
        `SELECT COUNT(*) AS total FROM ${table}${where.sql}`,
        where.params,
        where.kinds,
      ),
    ]);
    return {
      data: data.rows,
      total: Number(count.rows[0]?.total ?? 0),
      page: safePage,
      limit: safeLimit,
    };
  }

  async insertTableData(
    id: string,
    userId: string,
    tableName: string,
    data: Record<string, unknown>,
  ) {
    const { target, dialect } = await this.connectionFor(id, userId);
    const columns = await this.tableColumns(target, dialect, tableName);
    const values = this.buildValues(target, columns, data);
    const pk = columns.filter((c) => c.columnKey === 'PRI');

    if (target.type === ClusterType.MYSQL) {
      const res = await this.executor.run(
        target,
        dialect.insert(tableRef(columns), values.names, false),
        values.params,
        values.kinds,
      );
      // Read the row back so the client sees defaults and the generated key.
      const key: Record<string, unknown> = {};
      for (const c of pk) {
        if (data[c.name] !== undefined && data[c.name] !== null)
          key[c.name] = data[c.name];
        else if (c.isAutoIncrement && res.insertId) key[c.name] = res.insertId;
      }
      if (pk.length > 0 && Object.keys(key).length === pk.length) {
        const w = this.buildWhere(target, dialect, columns, key, 1);
        const { rows } = await this.executor.run(
          target,
          `SELECT * FROM ${dialect.qualify(tableRef(columns))} WHERE ${w.sql} LIMIT 1`,
          w.params,
          w.kinds,
        );
        if (rows[0]) return rows[0];
      }
      return { ...data };
    }

    try {
      const { rows } = await this.executor.run(
        target,
        dialect.insert(tableRef(columns), values.names, true),
        values.params,
        values.kinds,
      );
      return rows[0] ?? { ...data };
    } catch (error) {
      // SQL Server rejects OUTPUT on tables with triggers; insert without it.
      if (
        target.type === ClusterType.MSSQL &&
        /OUTPUT clause/i.test((error as Error).message)
      ) {
        await this.executor.run(
          target,
          dialect.insert(tableRef(columns), values.names, false),
          values.params,
          values.kinds,
        );
        return { ...data };
      }
      throw new BadRequestException((error as Error).message);
    }
  }

  async updateTableData(
    id: string,
    userId: string,
    tableName: string,
    data: Record<string, unknown>,
    where: Record<string, unknown>,
  ) {
    const { target, dialect } = await this.connectionFor(id, userId);
    const columns = await this.tableColumns(target, dialect, tableName);
    const values = this.buildValues(target, columns, data);
    if (values.names.length === 0)
      throw new BadRequestException('Nothing to update.');
    const set = values.names
      .map((n, i) => `${dialect.quote(n)} = ${dialect.param(i + 1)}`)
      .join(', ');
    const w = this.buildWhere(
      target,
      dialect,
      columns,
      where,
      values.params.length + 1,
    );
    const sql = w.coversKey
      ? `UPDATE ${dialect.qualify(tableRef(columns))} SET ${set} WHERE ${w.sql}`
      : dialect.updateOne(tableRef(columns), set, w.sql); // no unique key: touch one row only

    const { rowCount } = await this.executor.run(
      target,
      sql,
      [...values.params, ...w.params],
      [...values.kinds, ...w.kinds],
    );
    if (rowCount === 0) {
      throw new NotFoundException(
        'No matching row found. It may have been changed or deleted.',
      );
    }
    return { affectedRows: rowCount };
  }

  async deleteTableData(
    id: string,
    userId: string,
    tableName: string,
    body: {
      where?: Record<string, unknown>;
      wheres?: Record<string, unknown>[];
    },
  ) {
    const { target, dialect } = await this.connectionFor(id, userId);
    const columns = await this.tableColumns(target, dialect, tableName);
    const list = body?.wheres ?? (body?.where ? [body.where] : []);
    if (list.length === 0) throw new BadRequestException('Nothing to delete.');

    const statements = list.map((where) => {
      const w = this.buildWhere(target, dialect, columns, where, 1);
      return {
        sql: w.coversKey
          ? `DELETE FROM ${dialect.qualify(tableRef(columns))} WHERE ${w.sql}`
          : dialect.deleteOne(tableRef(columns), w.sql),
        params: w.params,
        paramKinds: w.kinds,
      };
    });

    let affected = 0;
    if (statements.length === 1) {
      affected = (await this.executor.runStatement(target, statements[0]))
        .rowCount;
      if (affected === 0) {
        throw new NotFoundException(
          'No matching row found. It may have been changed or deleted.',
        );
      }
    } else {
      const results = await this.executor.transaction(target, (tx) =>
        tx.runMany(statements),
      );
      affected = results.reduce((sum, r) => sum + r.rowCount, 0);
    }
    return { affectedRows: affected };
  }

  // ─── Destructive actions ─────────────────────────────────────────────────

  /** Server-side "Destructive Action Lock" from Project Settings (on by default). */
  async assertNotLocked(userId: string, what: string) {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      select: ['id', 'settings'],
    });
    if (user?.settings?.destructiveActionLock !== false) {
      throw new ForbiddenException(
        `${what} is blocked by the Destructive Action Lock. Turn it off in Project Settings to continue.`,
      );
    }
  }

  async dropTable(clusterId: string, userId: string, tableName: string) {
    await this.assertNotLocked(userId, 'DROP TABLE');
    const { target, dialect } = await this.connectionFor(clusterId, userId);
    const columns = await this.tableColumns(target, dialect, tableName);
    const sql = dialect.dropTable(tableRef(columns));
    const started = Date.now();
    try {
      await this.executor.run(target, sql);
      await this.log(clusterId, userId, sql, started, true, null);
      return { success: true };
    } catch (error) {
      await this.log(
        clusterId,
        userId,
        sql,
        started,
        false,
        (error as Error).message,
      );
      throw new BadRequestException(
        `Failed to drop table: ${(error as Error).message}`,
      );
    }
  }

  // ─── Query editor ────────────────────────────────────────────────────────

  private async log(
    clusterId: string,
    userId: string,
    query: string,
    started: number,
    success: boolean,
    errorMessage: string | null,
  ) {
    try {
      await this.queryLogRepo.save({
        query,
        clusterId,
        userId,
        executionTimeMs: Date.now() - started,
        success,
        errorMessage: errorMessage ?? undefined,
      });
    } catch {
      // Logging must never hide the query's own result.
    }
  }

  async executeQuery(
    id: string,
    userId: string,
    query: string,
    page?: number,
    limit?: number,
  ) {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new BadRequestException('Query is empty.');
    }
    const { target } = await this.connectionFor(id, userId);
    const destructive = findDestructiveStatements(query, target.type);
    if (destructive.length > 0) {
      await this.assertNotLocked(userId, destructive.join(', '));
    }

    const started = Date.now();
    try {
      let results: unknown[];
      let totals: number[];
      if (page && limit && isSingleRowQuery(query, target.type)) {
        const sql = query.trim().replace(/;+\s*$/, '');
        const res = await this.executor.runPage(
          target,
          sql,
          (page - 1) * limit,
          limit,
        );
        results = [res.rows];
        totals = [res.total];
      } else {
        const res = await this.executor.runScript(target, query);
        results = res.results;
        totals = res.rowCounts;
      }
      await this.log(id, userId, query, started, true, null);
      return { results, totals, executionTimeMs: Date.now() - started };
    } catch (error) {
      await this.log(
        id,
        userId,
        query,
        started,
        false,
        (error as Error).message,
      );
      if (error instanceof ForbiddenException) throw error;
      throw new BadRequestException((error as Error).message);
    }
  }

  async getQueryLogs(clusterId: string, userId: string) {
    return this.queryLogRepo.find({
      where: { clusterId, userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  // ─── Compare ─────────────────────────────────────────────────────────────

  groupByTable(schema: ColumnInfo[]) {
    const tables: Record<string, ColumnInfo[]> = {};
    for (const col of schema) (tables[col.tableName] ??= []).push(col);
    return tables;
  }

  /** Same engine: compare exact types. Different engines: compare value kinds. */
  sameType(source: ColumnInfo, target: ColumnInfo, sameEngine: boolean) {
    if (sameEngine)
      return (
        source.fullType.toLowerCase().trim() ===
        target.fullType.toLowerCase().trim()
      );
    const loose = (k: ValueKind) =>
      k === 'integer' || k === 'bigint'
        ? 'int'
        : k === 'datetimetz'
          ? 'datetime'
          : k;
    return loose(source.kind) === loose(target.kind);
  }

  async compareSchemas(sourceId: string, targetId: string, userId: string) {
    const src = await this.connectionFor(sourceId, userId);
    const dst = await this.connectionFor(targetId, userId);
    const sourceTables = this.groupByTable(
      await this.schemaFor(src.target, src.dialect),
    );
    const targetTables = this.groupByTable(
      await this.schemaFor(dst.target, dst.dialect),
    );
    const sameEngine = src.target.type === dst.target.type;
    // Across engines without schemas, tables are matched by their bare name.
    const schemaAware =
      src.dialect.defaultSchema !== null && dst.dialect.defaultSchema !== null;
    const targetByKey = new Map(
      Object.values(targetTables).map((cols) => [
        matchKey(dst.dialect, tableRef(cols), schemaAware),
        cols,
      ]),
    );
    const sourceKeys = new Set(
      Object.values(sourceTables).map((cols) =>
        matchKey(src.dialect, tableRef(cols), schemaAware),
      ),
    );

    const diffs = {
      missingInTarget: [] as { tableName: string; columns: ColumnInfo[] }[],
      missingInSource: [] as { tableName: string; columns: ColumnInfo[] }[],
      tableMismatches: [] as any[],
      matchingTables: [] as { tableName: string; columns: ColumnInfo[] }[],
    };

    for (const [tableName, columns] of Object.entries(sourceTables)) {
      const other = targetByKey.get(
        matchKey(src.dialect, tableRef(columns), schemaAware),
      );
      if (!other) {
        diffs.missingInTarget.push({ tableName, columns });
        continue;
      }
      const targetMap = this.columnMap(other);
      const sourceMap = this.columnMap(columns);
      const missingColumns: any[] = [];
      const typeMismatches: any[] = [];
      for (const col of columns) {
        const t = targetMap.get(col.name);
        if (!t) missingColumns.push({ ...col, status: 'missing_in_target' });
        else if (!this.sameType(col, t, sameEngine)) {
          typeMismatches.push({
            name: col.name,
            sourceType: col.fullType,
            targetType: t.fullType,
          });
        }
      }
      for (const col of other) {
        if (!sourceMap.has(col.name))
          missingColumns.push({ ...col, status: 'missing_in_source' });
      }
      if (missingColumns.length || typeMismatches.length) {
        diffs.tableMismatches.push({
          tableName,
          hasDiff: true,
          missingColumns,
          typeMismatches,
        });
      } else {
        diffs.matchingTables.push({ tableName, columns });
      }
    }
    for (const [key, columns] of targetByKey) {
      if (!sourceKeys.has(key))
        diffs.missingInSource.push({
          tableName: columns[0].tableName,
          columns,
        });
    }
    return diffs;
  }

  /** Coerces a row of normalized values for insertion into `columns`. */
  rowValues(t: ConnectionTarget, columns: ColumnInfo[], row: Row) {
    const map = this.columnMap(columns);
    const names: string[] = [];
    const params: unknown[] = [];
    const kinds: (ValueKind | null)[] = [];
    for (const [name, value] of Object.entries(row)) {
      const column = map.get(name);
      if (!column) {
        throw new BadRequestException(
          `Column "${name}" does not exist in table "${columns[0]?.tableName}".`,
        );
      }
      if (column.isGenerated) continue;
      names.push(name);
      params.push(coerceValue(t.type, column, value));
      kinds.push(column.kind);
    }
    return { names, params, kinds };
  }
}

import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as mysql from 'mysql2/promise';
import * as pg from 'pg';
import * as mssql from 'mssql';
import { ClusterType } from '../entities/cluster.entity';
import './mssql-exact-decimals';
import { normalizeRows } from './values';
import { assertPublicHost } from './host-guard';
import { config } from '../../config/config.service';
import {
  ConnectionTarget,
  PageResult,
  Row,
  RunResult,
  ScriptResult,
  SslMode,
  Statement,
  TxHandle,
  ValueKind,
} from './types';

const IDLE_POOL_MS = 10 * 60 * 1000;
const QUERY_TIMEOUT_MS = 5 * 60 * 1000;

// Postgres types returned as their exact text instead of JS Dates/objects,
// so values round-trip without timezone shifts.
const PG_RAW_TEXT = new Set([
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1186, // interval
  1266, // timetz
  600, // point
  718, // circle
]);
const PG_TEXT_ARRAYS = new Set([1182, 1183, 1115, 1185, 1187, 1270]);
const pgTextArrayParser = (
  pg.types.getTypeParser as (oid: number) => (v: string) => unknown
)(1009);
const pgTypes = {
  getTypeParser(oid: number, format?: string) {
    if (PG_RAW_TEXT.has(oid)) return (v: string) => v;
    if (PG_TEXT_ARRAYS.has(oid)) return pgTextArrayParser;
    return (pg.types.getTypeParser as any)(oid, format);
  },
};

const NO_TLS_ERRORS =
  /does not support SSL|does not support secure connection|HANDSHAKE_NO_SSL_SUPPORT/i;

type Pool =
  | { engine: ClusterType.MYSQL; pool: mysql.Pool }
  | { engine: ClusterType.POSTGRES; pool: pg.Pool }
  | { engine: ClusterType.MSSQL; pool: mssql.ConnectionPool };

interface PoolEntry {
  fingerprint: string;
  pool: Pool;
  lastUsed: number;
}

function mysqlSsl(mode: SslMode) {
  if (mode === 'disable') return undefined;
  return { rejectUnauthorized: mode === 'verify' };
}

function pgSsl(mode: SslMode) {
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify' };
}

export function fingerprint(t: ConnectionTarget): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        t.type,
        t.host,
        t.port,
        t.username,
        t.password,
        t.database,
        t.sslMode,
      ]),
    )
    .digest('hex');
}

function isHeader(r: unknown): r is mysql.ResultSetHeader {
  return (
    !!r && typeof r === 'object' && !Array.isArray(r) && 'affectedRows' in r
  );
}

function bindMssql(
  request: mssql.Request,
  params: unknown[] = [],
  kinds: (ValueKind | null)[] = [],
) {
  params.forEach((value, i) => {
    const name = `p${i + 1}`;
    if (kinds[i] === 'binary') {
      request.input(name, mssql.VarBinary(mssql.MAX), value ?? null);
    } else if (value === null || value === undefined) {
      request.input(name, mssql.NVarChar(mssql.MAX), null);
    } else if (typeof value === 'number') {
      if (!Number.isInteger(value)) request.input(name, mssql.Float, value);
      else if (Math.abs(value) > 2147483647)
        request.input(name, mssql.BigInt, value);
      else request.input(name, mssql.Int, value);
    } else if (typeof value === 'string') {
      request.input(name, mssql.NVarChar(mssql.MAX), value);
    } else {
      request.input(name, value);
    }
  });
}

function mssqlColumnTypes(recordset: any): Record<string, string> {
  const out: Record<string, string> = {};
  const columns = recordset?.columns ?? {};
  for (const key of Object.keys(columns)) {
    const decl = columns[key]?.type?.declaration;
    if (decl) out[key] = String(decl);
  }
  return out;
}

@Injectable()
export class ConnectionManager implements OnModuleDestroy {
  private readonly logger = new Logger(ConnectionManager.name);
  private readonly pools = new Map<string, PoolEntry>();
  private readonly creating = new Map<string, Promise<PoolEntry>>();
  private readonly sweeper = setInterval(() => void this.sweep(), 60_000);

  constructor() {
    this.sweeper.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.sweeper);
    await Promise.all([...this.pools.keys()].map((id) => this.invalidate(id)));
  }

  /** Closes the cached pool for a cluster (after edits or deletion). */
  async invalidate(clusterId: string) {
    const entry = this.pools.get(clusterId);
    this.pools.delete(clusterId);
    if (entry) await this.closePool(entry.pool);
  }

  private async sweep() {
    const now = Date.now();
    for (const [id, entry] of this.pools) {
      if (now - entry.lastUsed > IDLE_POOL_MS) await this.invalidate(id);
    }
  }

  private async closePool(p: Pool) {
    try {
      if (p.engine === ClusterType.MSSQL) await p.pool.close();
      else await p.pool.end();
    } catch (e) {
      this.logger.warn(`Failed to close pool: ${(e as Error).message}`);
    }
  }

  private async getPool(t: ConnectionTarget): Promise<Pool> {
    if (t.type === ClusterType.SQLITE) {
      throw new BadRequestException(
        'SQLite databases can only be opened through the local agent.',
      );
    }
    const fp = fingerprint(t);
    const existing = this.pools.get(t.id);
    if (existing && existing.fingerprint === fp) {
      existing.lastUsed = Date.now();
      return existing.pool;
    }
    if (existing) await this.invalidate(t.id);

    const key = `${t.id}:${fp}`;
    let pending = this.creating.get(key);
    if (!pending) {
      pending = this.createPool(t).then((pool) => ({
        fingerprint: fp,
        pool,
        lastUsed: Date.now(),
      }));
      this.creating.set(key, pending);
    }
    try {
      const entry = await pending;
      this.pools.set(t.id, entry);
      return entry.pool;
    } finally {
      this.creating.delete(key);
    }
  }

  private async createPool(
    t: ConnectionTarget,
    forcePlain = false,
  ): Promise<Pool> {
    // Resolve once per pool: only public hosts unless explicitly allowed.
    if (!forcePlain && !config.ALLOW_PRIVATE_DB_HOSTS)
      await assertPublicHost(t.host);
    const mode: SslMode = forcePlain
      ? 'disable'
      : t.sslMode === 'prefer'
        ? 'require'
        : t.sslMode;
    try {
      if (t.type === ClusterType.MYSQL) {
        const pool = mysql.createPool({
          host: t.host,
          port: t.port,
          user: t.username,
          password: t.password ?? undefined,
          database: t.database,
          ssl: mysqlSsl(mode),
          connectionLimit: 5,
          maxIdle: 2,
          idleTimeout: 60_000,
          connectTimeout: 10_000,
          enableKeepAlive: true,
          multipleStatements: true,
          dateStrings: true,
          supportBigNumbers: true,
          bigNumberStrings: true,
        });
        try {
          const conn = await pool.getConnection();
          conn.release();
        } catch (e) {
          await pool.end().catch(() => undefined);
          throw e;
        }
        return { engine: ClusterType.MYSQL, pool };
      }
      if (t.type === ClusterType.POSTGRES) {
        const pool = new pg.Pool({
          host: t.host,
          port: t.port,
          user: t.username,
          password: t.password ?? undefined,
          database: t.database,
          ssl: pgSsl(mode),
          max: 5,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
          types: pgTypes as any,
        });
        pool.on('error', (err) =>
          this.logger.warn(
            `Idle client error for cluster ${t.id}: ${err.message}`,
          ),
        );
        try {
          const client = await pool.connect();
          client.release();
        } catch (e) {
          await pool.end().catch(() => undefined);
          throw e;
        }
        return { engine: ClusterType.POSTGRES, pool };
      }
      const pool = new mssql.ConnectionPool({
        server: t.host,
        port: t.port || 1433,
        user: t.username,
        password: t.password ?? undefined,
        database: t.database,
        connectionTimeout: 10_000,
        requestTimeout: QUERY_TIMEOUT_MS,
        pool: { max: 5, idleTimeoutMillis: 30_000 },
        options: {
          encrypt: mode !== 'disable',
          trustServerCertificate: mode !== 'verify',
          useUTC: true,
        },
      });
      await pool.connect();
      return { engine: ClusterType.MSSQL, pool };
    } catch (e) {
      if (
        t.sslMode === 'prefer' &&
        !forcePlain &&
        NO_TLS_ERRORS.test(String((e as Error).message))
      ) {
        return this.createPool(t, true);
      }
      throw e;
    }
  }

  /** Opens and closes a connection without caching it. */
  async test(t: ConnectionTarget): Promise<void> {
    const pool = await this.createPool(t);
    await this.closePool(pool);
  }

  async run(
    t: ConnectionTarget,
    sql: string,
    params: unknown[] = [],
    kinds: (ValueKind | null)[] = [],
  ): Promise<RunResult> {
    const p = await this.getPool(t);
    return this.runOn(p, sql, params, kinds);
  }

  private async runOn(
    p:
      | Pool
      | { engine: ClusterType.MYSQL; conn: mysql.PoolConnection }
      | { engine: ClusterType.POSTGRES; client: pg.PoolClient }
      | { engine: ClusterType.MSSQL; tx: mssql.Transaction },
    sql: string,
    params: unknown[] = [],
    kinds: (ValueKind | null)[] = [],
  ): Promise<RunResult> {
    if (p.engine === ClusterType.MYSQL) {
      const target = 'conn' in p ? p.conn : p.pool;
      const [res] = await target.query({
        sql,
        values: params,
        timeout: QUERY_TIMEOUT_MS,
      });
      if (isHeader(res)) {
        return {
          rows: [],
          rowCount: res.affectedRows,
          insertId: res.insertId || null,
        };
      }
      const rows = Array.isArray(res) ? (res as Row[]) : [];
      return { rows: normalizeRows(rows), rowCount: rows.length };
    }
    if (p.engine === ClusterType.POSTGRES) {
      const target = 'client' in p ? p.client : p.pool;
      const res = await target.query({ text: sql, values: params });
      return {
        rows: normalizeRows(res.rows as Row[]),
        rowCount: res.rowCount ?? res.rows.length,
      };
    }
    const request = 'tx' in p ? new mssql.Request(p.tx) : p.pool.request();
    bindMssql(request, params, kinds);
    const res = await request.query(sql);
    const recordset = res.recordset as any;
    const rows = recordset
      ? normalizeRows(recordset as Row[], mssqlColumnTypes(recordset))
      : [];
    const affected = (res.rowsAffected ?? []).reduce((a, b) => a + b, 0);
    return { rows, rowCount: recordset ? rows.length : affected };
  }

  async runScript(t: ConnectionTarget, sql: string): Promise<ScriptResult> {
    const p = await this.getPool(t);
    if (p.engine === ClusterType.MYSQL) {
      const [res, fields] = await p.pool.query({
        sql,
        timeout: QUERY_TIMEOUT_MS,
      });
      const multi =
        Array.isArray(res) &&
        Array.isArray(fields) &&
        (fields as unknown[]).some(
          (f) => f === undefined || f === null || Array.isArray(f),
        );
      const parts: unknown[] = multi ? (res as unknown[]) : [res];
      return this.toScriptResult(
        parts.map((r) =>
          isHeader(r)
            ? { affectedRows: r.affectedRows }
            : normalizeRows((r as Row[]) ?? []),
        ),
      );
    }
    if (p.engine === ClusterType.POSTGRES) {
      const res = (await p.pool.query(sql)) as
        | pg.QueryResult
        | pg.QueryResult[];
      const parts = Array.isArray(res) ? res : [res];
      return this.toScriptResult(
        parts.map((r) =>
          r.fields && r.fields.length > 0
            ? normalizeRows(r.rows as Row[])
            : { affectedRows: r.rowCount ?? 0 },
        ),
      );
    }
    const res = await p.pool.request().query(sql);
    const recordsets = (res.recordsets ?? []) as any[];
    if (recordsets.length > 0) {
      return this.toScriptResult(
        recordsets.map((rs) =>
          normalizeRows(rs as Row[], mssqlColumnTypes(rs)),
        ),
      );
    }
    return this.toScriptResult([
      { affectedRows: (res.rowsAffected ?? []).reduce((a, b) => a + b, 0) },
    ]);
  }

  private toScriptResult(
    results: (Row[] | { affectedRows: number })[],
  ): ScriptResult {
    return {
      results: results as Row[][],
      rowCounts: results.map((r) =>
        Array.isArray(r) ? r.length : r.affectedRows,
      ),
    };
  }

  /**
   * Runs a single row-returning statement unchanged and streams it, keeping
   * only rows [offset, offset + limit) and counting the rest. The query is
   * never wrapped in a subquery, so duplicate column names and ORDER BY
   * behave exactly as written.
   */
  async runPage(
    t: ConnectionTarget,
    sql: string,
    offset: number,
    limit: number,
  ): Promise<PageResult> {
    const p = await this.getPool(t);
    const rows: Row[] = [];
    let total = 0;
    const take = (row: Row) => {
      if (total >= offset && rows.length < limit) rows.push(row);
      total++;
    };

    if (p.engine === ClusterType.MYSQL) {
      const conn = await p.pool.getConnection();
      try {
        await new Promise<void>((resolve, reject) => {
          const q = (conn as any).connection.query({
            sql,
            timeout: QUERY_TIMEOUT_MS,
          });
          q.on('result', (row: unknown) => {
            if (!isHeader(row)) take(row as Row);
          });
          q.on('error', reject);
          q.on('end', resolve);
        });
      } finally {
        conn.release();
      }
      return { rows: normalizeRows(rows), total };
    }

    if (p.engine === ClusterType.POSTGRES) {
      const client = await p.pool.connect();
      try {
        await new Promise<void>((resolve, reject) => {
          const q = new pg.Query(sql);
          q.on('row', (row: Row) => take(row));
          q.on('error', reject);
          q.on('end', () => resolve());
          void client.query(q as any);
        });
      } finally {
        client.release();
      }
      return { rows: normalizeRows(rows), total };
    }

    let types: Record<string, string> = {};
    await new Promise<void>((resolve, reject) => {
      const request = p.pool.request();
      request.stream = true;
      request.on('recordset', (columns: any) => {
        types = mssqlColumnTypes({ columns });
      });
      request.on('row', (row: Row) => take(row));
      request.on('error', reject);
      request.on('done', () => resolve());
      const pending: any = request.query(sql);
      if (pending && typeof pending.catch === 'function') pending.catch(reject);
    });
    return { rows: normalizeRows(rows, types), total };
  }

  async transaction<T>(
    t: ConnectionTarget,
    fn: (tx: TxHandle) => Promise<T>,
  ): Promise<T> {
    const p = await this.getPool(t);

    if (p.engine === ClusterType.MYSQL) {
      const conn = await p.pool.getConnection();
      const handle = this.handleFor({ engine: ClusterType.MYSQL, conn });
      try {
        await conn.beginTransaction();
        const result = await fn(handle);
        await conn.commit();
        return result;
      } catch (e) {
        await conn.rollback().catch(() => undefined);
        throw e;
      } finally {
        conn.release();
      }
    }

    if (p.engine === ClusterType.POSTGRES) {
      const client = await p.pool.connect();
      const handle = this.handleFor({ engine: ClusterType.POSTGRES, client });
      try {
        await client.query('BEGIN');
        const result = await fn(handle);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    }

    const tx = new mssql.Transaction(p.pool);
    await tx.begin();
    const handle = this.handleFor({ engine: ClusterType.MSSQL, tx });
    try {
      const result = await fn(handle);
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
  }

  private handleFor(
    target:
      | { engine: ClusterType.MYSQL; conn: mysql.PoolConnection }
      | { engine: ClusterType.POSTGRES; client: pg.PoolClient }
      | { engine: ClusterType.MSSQL; tx: mssql.Transaction },
  ): TxHandle {
    const run = (
      sql: string,
      params?: unknown[],
      kinds?: (ValueKind | null)[],
    ) => this.runOn(target, sql, params, kinds);
    return {
      run,
      runMany: async (statements: Statement[]) => {
        const out: RunResult[] = [];
        for (const s of statements)
          out.push(await run(s.sql, s.params, s.paramKinds));
        return out;
      },
    };
  }
}

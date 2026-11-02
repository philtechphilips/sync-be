import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ClustersService } from './clusters.service';
import { ClusterEnvironment, ClusterType } from './entities/cluster.entity';
import {
  Dialect,
  matchKey,
  MSSQLDialect,
  PostgresDialect,
  tableRef,
} from './engine/dialects';
import { DbExecutor } from './engine/executor';
import { formatCsv, parseCsv } from './engine/csv';
import {
  findDestructiveStatements,
  splitEachStatement,
  splitStatements,
} from './engine/sql-splitter';
import { toText } from './engine/values';
import {
  ColumnInfo,
  ConnectionTarget,
  ForeignKeyInfo,
  IndexInfo,
  Row,
  Statement,
  TableRef,
  TxHandle,
} from './engine/types';
import { SyncSchemaDto } from './dto/data.dto';

const BATCH_ROWS = 2_000;
const ROWS_PER_INSERT = 100;
const MAX_BACKUP_ROWS = Number(process.env.MAX_BACKUP_ROWS) || 1_000_000;

interface Conn {
  target: ConnectionTarget;
  dialect: Dialect;
}

export interface SyncTableResult {
  tableName: string;
  success: boolean;
  error: string | null;
  created: boolean;
  addedColumns: string[];
  alteredColumns: string[];
  indexesCreated: string[];
  foreignKeysCreated: string[];
  rowsCopied: number;
  notes: string[];
}

/** Where a source table lives on the target engine. */
function targetRefFor(src: Dialect, dst: Dialect, ref: TableRef): TableRef {
  if (dst.defaultSchema === null) return { schema: null, table: ref.table };
  const schema =
    !ref.schema || ref.schema === src.defaultSchema
      ? dst.defaultSchema
      : ref.schema;
  return { schema, table: ref.table };
}

/** Orders tables so parents come before children that reference them. */
function parentsFirst(
  tables: string[],
  fks: ForeignKeyInfo[],
  keyOf: (fk: ForeignKeyInfo) => string | null,
) {
  const selected = new Set(tables);
  const deps = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const fk of fks) {
    const parent = keyOf(fk);
    if (
      parent &&
      parent !== fk.tableName &&
      selected.has(fk.tableName) &&
      selected.has(parent)
    ) {
      deps.get(fk.tableName)!.add(parent);
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, stack: Set<string>) => {
    if (seen.has(t) || stack.has(t)) return; // cycles: keep the original order
    stack.add(t);
    for (const d of deps.get(t) ?? []) visit(d, stack);
    stack.delete(t);
    seen.add(t);
    out.push(t);
  };
  for (const t of tables) visit(t, new Set());
  return out;
}

@Injectable()
export class TransferService {
  constructor(
    private readonly clusters: ClustersService,
    private readonly executor: DbExecutor,
  ) {}

  // ─── Reading ─────────────────────────────────────────────────────────────

  /** Reads every row of a table in stable (primary key) order. */
  private async *readRows(c: Conn, columns: ColumnInfo[]) {
    const orderBy = columns
      .filter((col) => col.columnKey === 'PRI')
      .map((col) => c.dialect.quote(col.name))
      .join(', ');
    const from = c.dialect.qualify(tableRef(columns));
    for (let offset = 0; ; offset += BATCH_ROWS) {
      const sql = `SELECT ${c.dialect.selectList(columns)} FROM ${from}${c.dialect.pageClause({ orderBy, limit: BATCH_ROWS, offset })}`;
      const { rows } = await this.executor.run(c.target, sql);
      if (rows.length > 0) yield rows;
      if (rows.length < BATCH_ROWS) return;
    }
  }

  private async readAll(
    c: Conn,
    columns: ColumnInfo[],
    budget: { left: number },
  ) {
    const all: Row[] = [];
    for await (const batch of this.readRows(c, columns)) {
      budget.left -= batch.length;
      if (budget.left < 0) {
        throw new PayloadTooLargeException(
          `This database has more than ${MAX_BACKUP_ROWS.toLocaleString()} rows, which is too large for an in-browser backup. Use your database's native dump tool (mysqldump, pg_dump, ...) instead.`,
        );
      }
      all.push(...batch);
    }
    return all;
  }

  // ─── Inserting ───────────────────────────────────────────────────────────

  /**
   * Builds parameterised INSERTs for rows of normalized values, handling
   * identity columns (OVERRIDING SYSTEM VALUE / IDENTITY_INSERT) and
   * optionally skipping rows whose primary key already exists.
   */
  private insertStatements(
    c: Conn,
    columns: ColumnInfo[],
    rows: Row[],
    skipExisting: boolean,
  ): Statement[] {
    const ref = tableRef(columns);
    const pk = columns
      .filter((col) => col.columnKey === 'PRI')
      .map((col) => col.name);
    const identity = columns
      .filter((col) => col.isAutoIncrement)
      .map((col) => col.name);
    const build = (names: string[], offset: number) =>
      skipExisting
        ? c.dialect.insertIfMissing(ref, names, pk, offset)
        : c.dialect.insert(ref, names, false, offset);

    if (c.target.type === ClusterType.MSSQL) {
      return this.mssqlInsertBatches(c, ref, columns, rows, identity, build);
    }

    const statements: Statement[] = rows.map((row) => {
      const v = this.clusters.rowValues(c.target, columns, row);
      let sql = build(v.names, 0);
      if (
        c.target.type === ClusterType.POSTGRES &&
        v.names.some((n) => identity.includes(n))
      ) {
        sql = sql.replace(/\) VALUES \(/, ') OVERRIDING SYSTEM VALUE VALUES (');
      }
      return { sql, params: v.params, paramKinds: v.kinds };
    });
    if (c.target.type === ClusterType.POSTGRES) {
      for (const col of identity) {
        statements.push({
          sql: (c.dialect as PostgresDialect).resetSequence(ref, col),
        });
      }
    }
    return statements;
  }

  /**
   * SQL Server resets SET IDENTITY_INSERT when each request ends, so the
   * SET and its INSERTs must travel in one batch. Rows are grouped into
   * batches below the 2100-parameter limit.
   */
  private mssqlInsertBatches(
    c: Conn,
    ref: TableRef,
    columns: ColumnInfo[],
    rows: Row[],
    identity: string[],
    build: (names: string[], offset: number) => string,
  ): Statement[] {
    const dialect = c.dialect as MSSQLDialect;
    const out: Statement[] = [];
    let sql: string[] = [];
    let params: unknown[] = [];
    let kinds: Statement['paramKinds'] = [];
    let identityOn = false;
    const flush = () => {
      if (sql.length === 0) return;
      if (identityOn) sql.push(dialect.identityInsert(ref, false));
      out.push({ sql: sql.join(';\n'), params, paramKinds: kinds });
      sql = [];
      params = [];
      kinds = [];
      identityOn = false;
    };
    for (const row of rows) {
      const v = this.clusters.rowValues(c.target, columns, row);
      if (params.length + v.params.length > 2000 || sql.length >= 500) flush();
      if (!identityOn && v.names.some((n) => identity.includes(n))) {
        sql.push(dialect.identityInsert(ref, true));
        identityOn = true;
      }
      sql.push(build(v.names, params.length));
      params.push(...v.params);
      kinds.push(...v.kinds);
    }
    flush();
    return out;
  }

  // ─── Backup ──────────────────────────────────────────────────────────────

  async backup(id: string, userId: string, format: 'sql' | 'csv' | 'json') {
    if (!['sql', 'csv', 'json'].includes(format)) {
      throw new BadRequestException('Format must be sql, csv or json.');
    }
    const { cluster, target, dialect } = await this.clusters.connectionFor(
      id,
      userId,
    );
    const c = { target, dialect };
    const tables = this.clusters.groupByTable(
      await this.clusters.schemaFor(target, dialect),
    );
    const budget = { left: MAX_BACKUP_ROWS };

    if (format === 'sql') {
      return { content: await this.sqlBackup(c, cluster.name, tables, budget) };
    }
    const out: Record<string, unknown> = {};
    for (const [table, columns] of Object.entries(tables)) {
      const rows = await this.readAll(c, columns, budget);
      out[table] =
        format === 'json'
          ? rows
          : formatCsv(
              rows,
              [...columns]
                .sort((a, b) => a.ordinal - b.ordinal)
                .map((col) => col.name),
            );
    }
    return out;
  }

  private insertLiterals(
    c: Conn,
    columns: ColumnInfo[],
    rows: Row[],
  ): string[] {
    const cols = columns.filter((col) => !col.isGenerated);
    if (rows.length === 0 || cols.length === 0) return [];
    const names = cols.map((col) => c.dialect.quote(col.name)).join(', ');
    const overriding =
      c.target.type === ClusterType.POSTGRES &&
      cols.some((col) => col.isAutoIncrement)
        ? ' OVERRIDING SYSTEM VALUE'
        : '';
    const table = c.dialect.qualify(tableRef(columns));
    const out: string[] = [];
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      const values = rows
        .slice(i, i + ROWS_PER_INSERT)
        .map(
          (row) =>
            `(${cols.map((col) => c.dialect.literal(row[col.name], col)).join(', ')})`,
        )
        .join(',\n  ');
      out.push(
        `INSERT INTO ${table} (${names})${overriding} VALUES\n  ${values};`,
      );
    }
    return out;
  }

  private async sqlBackup(
    c: Conn,
    name: string,
    tables: Record<string, ColumnInfo[]>,
    budget: { left: number },
  ): Promise<string> {
    const engine = c.target.type;
    const out: string[] = [
      `-- SynqDB backup of "${name.replaceAll('\n', ' ')}" (${engine})`,
      `-- Created ${new Date().toISOString()}`,
      '',
    ];
    const after: string[] = [];

    if (engine === ClusterType.MYSQL) out.push('SET FOREIGN_KEY_CHECKS=0;', '');
    if (engine === ClusterType.SQLITE)
      out.push('PRAGMA defer_foreign_keys = ON;', '');

    const schemas = [
      ...new Set(
        Object.values(tables)
          .map((cols) => cols[0].schema)
          .filter((s): s is string => !!s && s !== c.dialect.defaultSchema),
      ),
    ];
    for (const schema of schemas) {
      const ddl = c.dialect.createSchema(schema);
      if (ddl) out.push(`${ddl};`);
    }
    if (engine === ClusterType.POSTGRES)
      out.push(...(await this.pgEnumTypes(c)));
    if (engine === ClusterType.MSSQL && schemas.length) out.push('GO');
    out.push('');

    for (const columns of Object.values(tables)) {
      const ref = tableRef(columns);
      out.push(`-- Table ${columns[0].tableName}`);
      out.push(`${await this.tableDdl(c, ref, columns)};`);
      const rows = await this.readAll(c, columns, budget);
      const identity = columns.some((col) => col.isAutoIncrement);
      if (engine === ClusterType.MSSQL && identity && rows.length > 0) {
        out.push(`${(c.dialect as MSSQLDialect).identityInsert(ref, true)};`);
      }
      out.push(...this.insertLiterals(c, columns, rows));
      if (engine === ClusterType.MSSQL && identity && rows.length > 0) {
        out.push(`${(c.dialect as MSSQLDialect).identityInsert(ref, false)};`);
      }
      if (engine === ClusterType.POSTGRES) {
        for (const col of columns.filter((x) => x.isAutoIncrement)) {
          out.push(
            `${(c.dialect as PostgresDialect).resetSequence(ref, col.name)};`,
          );
        }
      }
      // SET IDENTITY_INSERT only lasts for its batch, so each table is one batch.
      if (engine === ClusterType.MSSQL) out.push('GO');
      out.push('');
    }

    if (engine === ClusterType.POSTGRES)
      after.push(...(await this.pgConstraintsAndIndexes(c)));
    if (engine === ClusterType.MSSQL)
      after.push(...(await this.mssqlConstraintsAndIndexes(c, tables)));
    if (engine === ClusterType.SQLITE)
      after.push(...(await this.sqliteIndexesAndTriggers(c)));
    if (engine === ClusterType.MYSQL) after.push('SET FOREIGN_KEY_CHECKS=1;');
    return [...out, ...after, ''].join('\n');
  }

  private async tableDdl(
    c: Conn,
    ref: TableRef,
    columns: ColumnInfo[],
  ): Promise<string> {
    if (c.target.type === ClusterType.MYSQL) {
      const { rows } = await this.executor.run(
        c.target,
        `SHOW CREATE TABLE ${c.dialect.qualify(ref)}`,
      );
      const ddl = toText(rows[0]?.['Create Table']);
      if (ddl)
        return ddl.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
    }
    if (c.target.type === ClusterType.SQLITE) {
      const { rows } = await this.executor.run(
        c.target,
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        [ref.table],
      );
      const ddl = toText(rows[0]?.sql);
      if (ddl)
        return ddl.replace(
          /^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i,
          'CREATE TABLE IF NOT EXISTS ',
        );
    }
    return c.dialect.createTable(ref, columns, c.target.type);
  }

  private async pgEnumTypes(c: Conn): Promise<string[]> {
    const { rows } = await this.executor.run(
      c.target,
      `SELECT n.nspname AS schema, t.typname AS name,
         string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
       GROUP BY n.nspname, t.typname ORDER BY n.nspname, t.typname`,
    );
    return rows.map((r) => {
      const type = c.dialect.qualify({
        schema: toText(r.schema),
        table: toText(r.name),
      });
      return `DO $synq$ BEGIN CREATE TYPE ${type} AS ENUM (${toText(r.labels)}); EXCEPTION WHEN duplicate_object THEN NULL; END $synq$;`;
    });
  }

  private async pgConstraintsAndIndexes(c: Conn): Promise<string[]> {
    const constraints = await this.executor.run(
      c.target,
      `SELECT con.conrelid::regclass::text AS tbl, con.conname, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
       WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' AND con.contype IN ('u', 'c', 'f')
       ORDER BY CASE con.contype WHEN 'u' THEN 0 WHEN 'c' THEN 1 ELSE 2 END, con.conname`,
    );
    const indexes = await this.executor.run(
      c.target,
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname <> 'information_schema' AND schemaname !~ '^pg_'
         AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE contype IN ('p', 'u', 'x'))
       ORDER BY schemaname, indexname`,
    );
    return [
      '-- Constraints and indexes',
      ...constraints.rows.map(
        (r) =>
          `DO $synq$ BEGIN ALTER TABLE ${toText(r.tbl)} ADD CONSTRAINT ${c.dialect.quote(toText(r.conname))} ${toText(r.def)}; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $synq$;`,
      ),
      ...indexes.rows.map(
        (r) =>
          `${toText(r.indexdef).replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS ')};`,
      ),
    ];
  }

  private async mssqlConstraintsAndIndexes(
    c: Conn,
    tables: Record<string, ColumnInfo[]>,
  ): Promise<string[]> {
    const d = c.dialect as MSSQLDialect;
    const lit = (s: string) => s.replaceAll("'", "''");
    const out: string[] = ['-- Indexes and constraints'];

    for (const index of await this.clusters.indexesFor(c.target, d)) {
      const columns = tables[index.tableName];
      const ddl =
        columns &&
        d.createIndex(tableRef(columns), index, ClusterType.MSSQL, columns);
      if (!ddl) continue;
      const ref = d.qualify(tableRef(columns));
      out.push(
        `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'${lit(index.name)}' AND object_id = OBJECT_ID(N'${lit(ref)}')) ${ddl};`,
      );
    }

    const checks = await this.executor.run(
      c.target,
      `SELECT s.name AS sch, t.name AS tbl, cc.name AS name, cc.definition AS def
       FROM sys.check_constraints cc
       JOIN sys.tables t ON t.object_id = cc.parent_object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       ORDER BY s.name, t.name, cc.name`,
    );
    for (const r of checks.rows) {
      const ref = d.qualify({ schema: toText(r.sch), table: toText(r.tbl) });
      const name = d.qualify({ schema: toText(r.sch), table: toText(r.name) });
      out.push(
        `IF OBJECT_ID(N'${lit(name)}', N'C') IS NULL ALTER TABLE ${ref} ADD CONSTRAINT ${d.quote(toText(r.name))} CHECK ${toText(r.def)};`,
      );
    }

    for (const fk of await this.clusters.foreignKeysFor(c.target, d)) {
      const ref = { schema: fk.schema, table: fk.table };
      const target = { schema: fk.refSchema, table: fk.refTable };
      const name = d.qualify({ schema: fk.schema, table: fk.name });
      out.push(
        `IF OBJECT_ID(N'${lit(name)}', N'F') IS NULL ${d.addForeignKey(ref, fk, target)};`,
      );
    }
    return out;
  }

  private async sqliteIndexesAndTriggers(c: Conn): Promise<string[]> {
    const { rows } = await this.executor.run(
      c.target,
      "SELECT type, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name",
    );
    return rows.map(
      (r) =>
        `${toText(r.sql).replace(/^\s*CREATE\s+(UNIQUE\s+)?(INDEX|TRIGGER)\s+(IF\s+NOT\s+EXISTS\s+)?/i, (_m, u, kind) => `CREATE ${u ?? ''}${String(kind).toUpperCase()} IF NOT EXISTS `)};`,
    );
  }

  // ─── Restore ─────────────────────────────────────────────────────────────

  async restore(
    id: string,
    userId: string,
    format: 'sql' | 'csv' | 'json',
    data: Record<string, unknown>,
  ) {
    const { target, dialect } = await this.clusters.connectionFor(id, userId);
    const c = { target, dialect };

    if (format === 'sql') {
      const content = data?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new BadRequestException('The SQL backup is empty.');
      }
      const destructive = findDestructiveStatements(content, target.type);
      if (destructive.length > 0) {
        await this.clusters.assertNotLocked(
          userId,
          `Restoring a file with ${destructive.join(', ')}`,
        );
      }
      // SQL Server runs whole GO batches (session SETs live per batch).
      const statements = (
        target.type === ClusterType.MSSQL
          ? splitStatements(content, target.type)
          : splitEachStatement(content, target.type).map((s) => s.text)
      ).map((sql) => ({ sql }));
      return this.inTransaction(
        c,
        (tx) => tx.runMany(statements),
        statements.length,
      );
    }

    const tables: Record<string, Row[]> = {};
    for (const [table, value] of Object.entries(data ?? {})) {
      if (format === 'json') {
        if (!Array.isArray(value))
          throw new BadRequestException(`"${table}" must be an array of rows.`);
        tables[table] = value as Row[];
      } else {
        if (typeof value !== 'string')
          throw new BadRequestException(`"${table}" must be CSV text.`);
        tables[table] = parseCsv(value).rows;
      }
    }

    const statements: Statement[] = [];
    for (const [table, rows] of Object.entries(tables)) {
      const columns = await this.clusters
        .tableColumns(target, dialect, table)
        .catch(() => {
          throw new BadRequestException(
            `Table "${table}" does not exist in this database. Restore a SQL backup first to create the tables.`,
          );
        });
      const prepared =
        format === 'csv' ? rows.map((r) => this.fromCsv(columns, r)) : rows;
      statements.push(...this.insertStatements(c, columns, prepared, false));
    }
    return this.inTransaction(
      c,
      (tx) => tx.runMany(statements),
      statements.length,
    );
  }

  /** CSV holds JSON columns as JSON text; turn them back into JSON values. */
  private fromCsv(columns: ColumnInfo[], row: Row): Row {
    const kinds = new Map(columns.map((col) => [col.name, col.kind]));
    const out: Row = {};
    for (const [key, value] of Object.entries(row)) {
      if (
        typeof value === 'string' &&
        (kinds.get(key) === 'json' || kinds.get(key) === 'array')
      ) {
        try {
          out[key] = JSON.parse(value);
          continue;
        } catch {
          /* keep as text */
        }
      }
      out[key] = value;
    }
    return out;
  }

  private async inTransaction(
    c: Conn,
    fn: (tx: TxHandle) => Promise<unknown>,
    count: number,
  ) {
    try {
      await this.executor.transaction(c.target, fn);
      return { success: true, statements: count };
    } catch (error) {
      const note =
        c.target.type === ClusterType.MYSQL
          ? ' Data changes were rolled back, but MySQL commits CREATE/ALTER statements immediately, so tables created before the error remain.'
          : ' All changes were rolled back.';
      throw new BadRequestException(
        `Restore failed: ${(error as Error).message}.${note}`,
      );
    }
  }

  // ─── Sync ────────────────────────────────────────────────────────────────

  async syncSchema(
    sourceId: string,
    targetId: string,
    userId: string,
    dto: SyncSchemaDto,
  ) {
    if (sourceId === targetId)
      throw new BadRequestException('Source and target must differ.');
    const srcConn = await this.clusters.connectionFor(sourceId, userId);
    const dstConn = await this.clusters.connectionFor(targetId, userId);
    if (
      dstConn.cluster.environment === ClusterEnvironment.PRODUCTION &&
      !dto.confirmProduction
    ) {
      throw new BadRequestException(
        `"${dstConn.cluster.name}" is a production cluster. Confirm the sync to continue.`,
      );
    }
    const src: Conn = { target: srcConn.target, dialect: srcConn.dialect };
    const dst: Conn = { target: dstConn.target, dialect: dstConn.dialect };
    const schemaAware =
      src.dialect.defaultSchema !== null && dst.dialect.defaultSchema !== null;

    const sourceTables = this.clusters.groupByTable(
      await this.clusters.schemaFor(src.target, src.dialect),
    );
    const loadTarget = async () => {
      const byKey = new Map<string, ColumnInfo[]>();
      for (const cols of Object.values(
        this.clusters.groupByTable(
          await this.clusters.schemaFor(dst.target, dst.dialect),
        ),
      )) {
        byKey.set(matchKey(dst.dialect, tableRef(cols), schemaAware), cols);
      }
      return byKey;
    };
    let targetTables = await loadTarget();
    const sourceFks = await this.clusters.foreignKeysFor(
      src.target,
      src.dialect,
    );
    const sourceIndexes = await this.clusters.indexesFor(
      src.target,
      src.dialect,
    );

    const keyOfSource = (schema: string | null, table: string) =>
      matchKey(src.dialect, { schema, table }, schemaAware);
    const sourceByKey = new Map(
      Object.values(sourceTables).map((cols) => [
        keyOfSource(cols[0].schema, cols[0].table),
        cols,
      ]),
    );

    // ── 1. Tables and columns ────────────────────────────────────────────
    const results = new Map<string, SyncTableResult>();
    const plan: {
      name: string;
      source: ColumnInfo[];
      ref: TableRef;
      key: string;
    }[] = [];
    const createdSchemas = new Set<string>();

    for (const tableName of dto.tableNames) {
      const result: SyncTableResult = {
        tableName,
        success: true,
        error: null,
        created: false,
        addedColumns: [],
        alteredColumns: [],
        indexesCreated: [],
        foreignKeysCreated: [],
        rowsCopied: 0,
        notes: [],
      };
      results.set(tableName, result);
      const source = sourceTables[tableName];
      if (!source) {
        Object.assign(result, {
          success: false,
          error: 'Table not found in source.',
        });
        continue;
      }
      const key = matchKey(src.dialect, tableRef(source), schemaAware);
      const existing = targetTables.get(key);
      const ref = existing
        ? tableRef(existing)
        : targetRefFor(src.dialect, dst.dialect, tableRef(source));
      plan.push({ name: tableName, source, ref, key });

      try {
        const ddl: string[] = [];
        if (!existing) {
          if (
            ref.schema &&
            ref.schema !== dst.dialect.defaultSchema &&
            !createdSchemas.has(ref.schema)
          ) {
            const schemaDdl = dst.dialect.createSchema(ref.schema);
            if (schemaDdl) ddl.push(schemaDdl);
            createdSchemas.add(ref.schema);
          }
          // SQLite can only declare foreign keys inside CREATE TABLE.
          const inlineFks =
            dst.target.type === ClusterType.SQLITE
              ? sourceFks
                  .filter((fk) => fk.tableName === tableName)
                  .map((fk) =>
                    this.resolveForeignKey(
                      src,
                      dst,
                      fk,
                      sourceByKey,
                      schemaAware,
                    ),
                  )
                  .filter(
                    (x): x is { fk: ForeignKeyInfo; ref: TableRef } =>
                      x !== null,
                  )
              : [];
          ddl.push(
            dst.dialect.createTable(ref, source, src.target.type, inlineFks),
          );
          result.created = true;
          result.foreignKeysCreated.push(...inlineFks.map((x) => x.fk.name));
        } else {
          const byName = new Map(existing.map((col) => [col.name, col]));
          for (const col of source) {
            const current = byName.get(col.name);
            if (!current) {
              ddl.push(dst.dialect.addColumn(ref, col, src.target.type));
              result.addedColumns.push(col.name);
            } else if (
              !this.clusters.sameType(
                col,
                current,
                src.target.type === dst.target.type,
              )
            ) {
              const alter = dst.dialect.alterColumnType(
                ref,
                col,
                src.target.type,
              );
              if (alter) {
                ddl.push(alter);
                result.alteredColumns.push(col.name);
              } else {
                result.notes.push(
                  `Type of "${col.name}" differs but SQLite can't change column types.`,
                );
              }
            }
          }
          const extra = existing.filter(
            (col) => !source.some((s) => s.name === col.name),
          );
          if (extra.length) {
            result.notes.push(
              `Kept target-only columns: ${extra.map((col) => col.name).join(', ')}.`,
            );
          }
        }
        if (ddl.length > 0) {
          await this.executor.transaction(dst.target, (tx) =>
            tx.runMany(ddl.map((sql) => ({ sql }))),
          );
        }
      } catch (error) {
        result.success = false;
        result.error = (error as Error).message;
      }
    }
    targetTables = await loadTarget();

    // ── 2. Data (parents before children) ────────────────────────────────
    if (dto.withData) {
      const byName = new Map(plan.map((p) => [p.name, p]));
      const order = parentsFirst(
        plan.map((p) => p.name),
        sourceFks,
        (fk) =>
          sourceByKey.get(keyOfSource(fk.refSchema, fk.refTable))?.[0]
            .tableName ?? null,
      );
      for (const name of order) {
        const p = byName.get(name)!;
        const result = results.get(name)!;
        const columns = targetTables.get(p.key);
        if (!result.success || !columns) continue;
        if (
          !result.created &&
          !columns.some((col) => col.columnKey === 'PRI')
        ) {
          result.notes.push(
            'Data not copied: the target table has no primary key to match existing rows.',
          );
          continue;
        }
        try {
          await this.executor.transaction(dst.target, async (tx) => {
            for await (const batch of this.readRows(src, p.source)) {
              await tx.runMany(
                this.insertStatements(dst, columns, batch, !result.created),
              );
              result.rowsCopied += batch.length;
            }
          });
          if (!result.created)
            result.notes.push(
              'Rows whose primary key already existed were left unchanged.',
            );
        } catch (error) {
          result.success = false;
          result.error = (error as Error).message;
        }
      }
    }

    // ── 3. Indexes and 4. foreign keys ───────────────────────────────────
    for (const p of plan) {
      const result = results.get(p.name)!;
      const columns = targetTables.get(p.key);
      if (!result.success || !columns) continue;
      await this.syncIndexes(src, dst, p, columns, sourceIndexes, result);
    }
    for (const p of plan) {
      const result = results.get(p.name)!;
      if (!result.success || dst.target.type === ClusterType.SQLITE) {
        if (
          result.success &&
          !result.created &&
          sourceFks.some((fk) => fk.tableName === p.name)
        ) {
          result.notes.push(
            "SQLite can't add foreign keys to an existing table.",
          );
        }
        continue;
      }
      await this.syncForeignKeys(
        src,
        dst,
        p,
        sourceFks,
        sourceByKey,
        targetTables,
        schemaAware,
        result,
      );
    }

    return dto.tableNames.map((name) => results.get(name)!);
  }

  /** Maps a source foreign key to the matching target table, if there is one. */
  private resolveForeignKey(
    src: Conn,
    dst: Conn,
    fk: ForeignKeyInfo,
    sourceByKey: Map<string, ColumnInfo[]>,
    schemaAware: boolean,
  ): { fk: ForeignKeyInfo; ref: TableRef } | null {
    const parent = sourceByKey.get(
      matchKey(
        src.dialect,
        { schema: fk.refSchema, table: fk.refTable },
        schemaAware,
      ),
    );
    if (!parent) return null;
    // SQLite allows "REFERENCES t" without columns (= its primary key).
    const refColumns = fk.refColumns.length
      ? fk.refColumns
      : parent.filter((c) => c.columnKey === 'PRI').map((c) => c.name);
    return {
      fk: { ...fk, refColumns },
      ref: targetRefFor(src.dialect, dst.dialect, tableRef(parent)),
    };
  }

  private async syncIndexes(
    src: Conn,
    dst: Conn,
    p: { name: string; ref: TableRef },
    targetColumns: ColumnInfo[],
    sourceIndexes: IndexInfo[],
    result: SyncTableResult,
  ) {
    const existing = await this.clusters.indexesFor(
      dst.target,
      dst.dialect,
      dst.dialect.displayName(p.ref),
    );
    const sameColumns = (a: string[], b: string[]) =>
      a.join('\u0000') === b.join('\u0000');
    for (const index of sourceIndexes.filter(
      (i) => i.tableName === p.name && !i.primary,
    )) {
      if (
        existing.some(
          (e) => e.name === index.name || sameColumns(e.columns, index.columns),
        )
      )
        continue;
      if (index.columns.some((c) => !targetColumns.some((t) => t.name === c)))
        continue;
      const ddl = dst.dialect.createIndex(
        p.ref,
        index,
        src.target.type,
        targetColumns,
      );
      if (!ddl) {
        result.notes.push(
          `Index "${index.name}" can't be recreated on ${dst.target.type} and was skipped.`,
        );
        continue;
      }
      try {
        await this.executor.run(dst.target, ddl);
        result.indexesCreated.push(index.name);
      } catch (error) {
        result.notes.push(
          `Index "${index.name}" was not created: ${(error as Error).message}`,
        );
      }
    }
  }

  private async syncForeignKeys(
    src: Conn,
    dst: Conn,
    p: { name: string; ref: TableRef },
    sourceFks: ForeignKeyInfo[],
    sourceByKey: Map<string, ColumnInfo[]>,
    targetTables: Map<string, ColumnInfo[]>,
    schemaAware: boolean,
    result: SyncTableResult,
  ) {
    const existing = await this.clusters.foreignKeysFor(
      dst.target,
      dst.dialect,
      dst.dialect.displayName(p.ref),
    );
    for (const fk of sourceFks.filter((f) => f.tableName === p.name)) {
      const resolved = this.resolveForeignKey(
        src,
        dst,
        fk,
        sourceByKey,
        schemaAware,
      );
      const parentKey =
        resolved && matchKey(dst.dialect, resolved.ref, schemaAware);
      if (!resolved || !parentKey || !targetTables.has(parentKey)) {
        result.notes.push(
          `Foreign key "${fk.name}" skipped: "${fk.refTable}" doesn't exist in the target.`,
        );
        continue;
      }
      const parent = tableRef(targetTables.get(parentKey)!);
      const duplicate = existing.some(
        (e) =>
          e.name === fk.name ||
          (e.columns.join(',') === fk.columns.join(',') &&
            e.refTable === parent.table),
      );
      if (duplicate) continue;
      const ddl = dst.dialect.addForeignKey(p.ref, resolved.fk, parent);
      if (!ddl) continue;
      try {
        await this.executor.run(dst.target, ddl);
        result.foreignKeysCreated.push(fk.name);
      } catch (error) {
        result.notes.push(
          `Foreign key "${fk.name}" was not created: ${(error as Error).message}`,
        );
      }
    }
  }
}

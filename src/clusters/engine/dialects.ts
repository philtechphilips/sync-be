import * as mysql from 'mysql2';
import { ClusterType } from '../entities/cluster.entity';
import { classifyColumn, toText } from './values';
import {
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  ReferentialAction,
  Row,
  Statement,
  TableRef,
  ValueKind,
} from './types';

const LENGTH_RE = /\((\d+)\s*(?:,\s*(\d+))?\)/;
const NUMBER_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const NOW_FUNCS =
  /^(current_timestamp(\(\d*\))?|now\(\)|getdate\(\)|sysdatetime\(\)|localtimestamp(\(\d*\))?|transaction_timestamp\(\))$/i;
/** Separator for aggregated name lists (ASCII "unit separator"). */
const US = '\u001f';

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return ['1', 'true', 't', 'yes', '0x01'].includes(toText(v).toLowerCase());
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 't';

function lengthOf(column: ColumnInfo): { len?: number; scale?: number } {
  const m = LENGTH_RE.exec(column.fullType || '');
  if (!m) return {};
  return {
    len: Number(m[1]),
    scale: m[2] !== undefined ? Number(m[2]) : undefined,
  };
}

function isCharType(column: ColumnInfo) {
  return /char/i.test(column.type) && !/text/i.test(column.type);
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => toText(v));
  const text = toText(value);
  return text === '' ? [] : text.split(US);
}

function action(value: unknown): ReferentialAction {
  const v = toText(value).toUpperCase().replaceAll('_', ' ');
  const letters: Record<string, ReferentialAction> = {
    A: 'NO ACTION',
    R: 'RESTRICT',
    C: 'CASCADE',
    N: 'SET NULL',
    D: 'SET DEFAULT',
  };
  if (letters[v]) return letters[v];
  return (
    ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'] as const
  ).includes(v as ReferentialAction)
    ? (v as ReferentialAction)
    : 'NO ACTION';
}

export interface PagingOptions {
  orderBy: string;
  limit: number;
  offset: number;
}

export abstract class Dialect {
  abstract readonly engine: ClusterType;
  /** Schema whose tables are shown without a prefix (null: no schemas). */
  abstract readonly defaultSchema: string | null;
  abstract quote(identifier: string): string;
  /** Placeholder for the n-th (1-based) parameter. */
  abstract param(n: number): string;
  abstract tablesQuery(): Statement;
  abstract columnsQuery(table?: string): Statement;
  abstract indexesQuery(table?: string): Statement;
  abstract foreignKeysQuery(table?: string): Statement;
  protected abstract normalizeRaw(raw: Row): Omit<ColumnInfo, 'kind'>;
  abstract pageClause(opts: PagingOptions): string;
  abstract updateOne(ref: TableRef, set: string, where: string): string;
  abstract deleteOne(ref: TableRef, where: string): string;
  abstract mapType(column: ColumnInfo, sourceEngine: ClusterType): string;
  abstract stringLiteral(value: string): string;
  abstract binaryLiteral(hex: string): string;
  abstract booleanLiteral(value: boolean): string;
  protected abstract createTableWrapper(ref: TableRef, body: string): string;
  protected abstract autoIncrementClause(column: ColumnInfo): string;
  abstract alterColumnType(
    ref: TableRef,
    column: ColumnInfo,
    sourceEngine: ClusterType,
  ): string | null;
  /** Insert that skips rows whose primary key already exists. */
  abstract insertIfMissing(
    ref: TableRef,
    columns: string[],
    pkColumns: string[],
    offset?: number,
  ): string;

  displayName(ref: TableRef) {
    return ref.schema && ref.schema !== this.defaultSchema
      ? `${ref.schema}.${ref.table}`
      : ref.table;
  }

  qualify(ref: TableRef) {
    return ref.schema
      ? `${this.quote(ref.schema)}.${this.quote(ref.table)}`
      : this.quote(ref.table);
  }

  /** CREATE SCHEMA statement, or null for engines without schemas. */
  createSchema(_schema: string): string | null {
    return null;
  }

  normalizeColumn(raw: Row): ColumnInfo {
    const base = this.normalizeRaw(raw);
    return {
      ...base,
      kind: classifyColumn(this.engine, base.type, base.fullType, base.udtName),
    };
  }

  normalizeIndex(r: Row): IndexInfo {
    const columns = splitList(r.cols);
    return {
      schema: (r.schema as string) ?? null,
      table: toText(r.table),
      tableName: toText(r.tableName),
      name: toText(r.name),
      unique: truthy(r.isUnique),
      primary: truthy(r.isPrimary),
      constraint: truthy(r.isConstraint),
      columns,
      descending: splitList(r.descending).map((d) => d === '1' || d === 'D'),
      prefixes: splitList(r.prefixes).map((p) => (p === '' ? null : Number(p))),
      include: splitList(r.include),
      where: (r.whereClause as string) ?? null,
      method: (r.method as string) ?? null,
      expression: truthy(r.isExpression) || columns.length === 0,
      definition: (r.definition as string) ?? null,
    };
  }

  normalizeForeignKey(r: Row): ForeignKeyInfo {
    return {
      schema: (r.schema as string) ?? null,
      table: toText(r.table),
      tableName: toText(r.tableName),
      name: toText(r.name),
      columns: splitList(r.cols),
      refSchema: (r.refSchema as string) ?? null,
      refTable: toText(r.refTable),
      refColumns: splitList(r.refCols).filter((c) => c !== ''),
      onDelete: action(r.onDelete),
      onUpdate: action(r.onUpdate),
    };
  }

  selectList(_columns: ColumnInfo[]): string {
    return '*';
  }

  /** `offset` shifts parameter numbers when several inserts share one batch. */
  insert(
    ref: TableRef,
    columns: string[],
    returning: boolean,
    offset = 0,
  ): string {
    const t = this.qualify(ref);
    const ret = returning ? ' RETURNING *' : '';
    if (columns.length === 0) return `INSERT INTO ${t} DEFAULT VALUES${ret}`;
    const cols = columns.map((c) => this.quote(c)).join(', ');
    const values = columns.map((_, i) => this.param(offset + i + 1)).join(', ');
    return `INSERT INTO ${t} (${cols}) VALUES (${values})${ret}`;
  }

  /** `col = ?` (or IS NULL), with casts where the type has no `=`. */
  equals(column: ColumnInfo, placeholder: string | null): string {
    const col = this.quote(column.name);
    return placeholder === null ? `${col} IS NULL` : `${col} = ${placeholder}`;
  }

  like(column: ColumnInfo, placeholder: string, negate: boolean): string {
    return `${this.quote(column.name)} ${negate ? 'NOT LIKE' : 'LIKE'} ${placeholder}`;
  }

  /** SQL literal for a normalized value (used to write backup files). */
  literal(value: unknown, column?: ColumnInfo): string {
    if (value === null || value === undefined) return 'NULL';
    const kind: ValueKind = column?.kind ?? 'other';
    if (
      kind === 'binary' &&
      typeof value === 'string' &&
      /^0x[0-9a-f]*$/i.test(value)
    ) {
      return this.binaryLiteral(value.slice(2));
    }
    if (kind === 'boolean') return this.booleanLiteral(toBool(value));
    if (kind === 'json') return this.stringLiteral(JSON.stringify(value));
    if (typeof value === 'boolean') return this.booleanLiteral(value);
    if (typeof value === 'number')
      return Number.isFinite(value) ? String(value) : 'NULL';
    if (
      ['integer', 'bigint', 'decimal', 'float'].includes(kind) &&
      typeof value === 'string' &&
      NUMBER_LITERAL.test(value.trim())
    ) {
      return value.trim();
    }
    if (typeof value === 'object')
      return this.stringLiteral(JSON.stringify(value));
    return this.stringLiteral(toText(value));
  }

  /** Column definition for CREATE TABLE / ADD COLUMN in this dialect. */
  columnDefinition(
    column: ColumnInfo,
    sourceEngine: ClusterType,
    opts: { inlinePrimaryKey?: boolean } = {},
  ): string {
    const sameEngine = sourceEngine === this.engine;
    const parts = [this.quote(column.name)];

    if (sameEngine && column.isGenerated && column.generationExpression) {
      parts.push(this.generatedClause(column));
      return parts.join(' ');
    }

    parts.push(this.mapType(column, sourceEngine));
    if (column.isAutoIncrement && this.canAutoIncrement(column)) {
      parts.push(this.autoIncrementClause(column));
    } else {
      const def = this.defaultClause(column, sourceEngine);
      if (def) parts.push(def);
    }
    if (column.nullable === 'NO' || column.columnKey === 'PRI')
      parts.push('NOT NULL');
    if (opts.inlinePrimaryKey) parts.push('PRIMARY KEY');
    if (sameEngine && column.onUpdate) parts.push(column.onUpdate);
    return parts.join(' ');
  }

  protected generatedClause(column: ColumnInfo): string {
    return `${column.fullType} GENERATED ALWAYS AS (${column.generationExpression}) STORED`;
  }

  protected canAutoIncrement(column: ColumnInfo): boolean {
    return column.kind === 'integer' || column.kind === 'bigint';
  }

  protected defaultClause(
    column: ColumnInfo,
    sourceEngine: ClusterType,
  ): string {
    const raw = column.defaultValue;
    if (raw === null || raw === undefined) return '';
    let def = String(raw).trim();
    if (def === '' || /^null$/i.test(def)) return '';
    if (sourceEngine === this.engine)
      return this.sameEngineDefault(column, def);

    // Cross-engine: only carry literals and "now"; functions differ per engine.
    while (/^\(.*\)$/.test(def)) def = def.slice(1, -1).trim(); // SQL Server ((0))
    def = def.replace(/::[\w\s."[\]]+$/, ''); // Postgres 'x'::character varying
    if (NOW_FUNCS.test(def)) return 'DEFAULT CURRENT_TIMESTAMP';
    if (
      column.kind === 'boolean' &&
      /^(true|false|'?[01]'?|b'[01]')$/i.test(def)
    ) {
      return `DEFAULT ${this.booleanLiteral(/true|1/i.test(def))}`;
    }
    if (NUMBER_LITERAL.test(def)) return `DEFAULT ${def}`;
    if (/^N?'(.*)'$/s.test(def)) {
      const inner = def.replace(/^N?'|'$/g, '').replaceAll("''", "'");
      return `DEFAULT ${this.stringLiteral(inner)}`;
    }
    if (sourceEngine === ClusterType.MYSQL && !/\(/.test(def)) {
      return `DEFAULT ${this.stringLiteral(def)}`; // MySQL reports literals unquoted
    }
    return '';
  }

  protected sameEngineDefault(_column: ColumnInfo, def: string): string {
    return `DEFAULT ${def}`;
  }

  createTable(
    ref: TableRef,
    columns: ColumnInfo[],
    sourceEngine: ClusterType,
    foreignKeys: { fk: ForeignKeyInfo; ref: TableRef }[] = [],
  ): string {
    const ordered = [...columns].sort((a, b) => a.ordinal - b.ordinal);
    const pk = ordered.filter((c) => c.columnKey === 'PRI');
    const inlinePk =
      this.engine === ClusterType.SQLITE &&
      pk.length === 1 &&
      pk[0].isAutoIncrement;
    const defs = ordered.map((c) =>
      this.columnDefinition(c, sourceEngine, {
        inlinePrimaryKey: inlinePk && c === pk[0],
      }),
    );
    if (pk.length > 0 && !inlinePk) {
      defs.push(
        `PRIMARY KEY (${pk.map((c) => this.quote(c.name)).join(', ')})`,
      );
    }
    for (const { fk, ref: target } of foreignKeys) {
      defs.push(this.foreignKeyClause(fk, target));
    }
    return this.createTableWrapper(ref, `(\n  ${defs.join(',\n  ')}\n)`);
  }

  addColumn(
    ref: TableRef,
    column: ColumnInfo,
    sourceEngine: ClusterType,
  ): string {
    const def = this.columnDefinition(
      { ...column, columnKey: '', isAutoIncrement: false },
      sourceEngine,
    );
    return `ALTER TABLE ${this.qualify(ref)} ADD ${this.engine === ClusterType.MSSQL ? '' : 'COLUMN '}${def}`;
  }

  dropTable(ref: TableRef): string {
    return `DROP TABLE IF EXISTS ${this.qualify(ref)}`;
  }

  protected referentialAction(a: ReferentialAction): string {
    return a;
  }

  protected foreignKeyClause(fk: ForeignKeyInfo, target: TableRef): string {
    const cols = fk.columns.map((c) => this.quote(c)).join(', ');
    const refCols = fk.refColumns.length
      ? ` (${fk.refColumns.map((c) => this.quote(c)).join(', ')})`
      : '';
    return `CONSTRAINT ${this.quote(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${this.qualify(target)}${refCols} ON DELETE ${this.referentialAction(fk.onDelete)} ON UPDATE ${this.referentialAction(fk.onUpdate)}`;
  }

  /** ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY, or null if unsupported. */
  addForeignKey(
    ref: TableRef,
    fk: ForeignKeyInfo,
    target: TableRef,
  ): string | null {
    return `ALTER TABLE ${this.qualify(ref)} ADD ${this.foreignKeyClause(fk, target)}`;
  }

  /** Index name that is unique where the engine scopes names per schema. */
  protected indexName(
    ref: TableRef,
    index: IndexInfo,
    sourceEngine: ClusterType,
  ) {
    if (sourceEngine === this.engine) return index.name;
    const perTableSource =
      sourceEngine === ClusterType.MYSQL || sourceEngine === ClusterType.MSSQL;
    const perSchemaTarget =
      this.engine === ClusterType.POSTGRES ||
      this.engine === ClusterType.SQLITE;
    if (
      perTableSource &&
      perSchemaTarget &&
      !index.name.startsWith(`${ref.table}_`)
    ) {
      return `${ref.table}_${index.name}`.slice(0, 63);
    }
    return index.name;
  }

  /**
   * CREATE INDEX for an index found on the source, or null when it can't be
   * expressed here (expression indexes across engines, unindexable types).
   */
  createIndex(
    ref: TableRef,
    index: IndexInfo,
    sourceEngine: ClusterType,
    _targetColumns: ColumnInfo[],
  ): string | null {
    if (index.primary || index.columns.length === 0) return null;
    if (index.expression && sourceEngine !== this.engine) return null;
    const name = this.quote(this.indexName(ref, index, sourceEngine));
    const cols = index.columns.map(
      (c, i) => `${this.quote(c)}${index.descending[i] ? ' DESC' : ''}`,
    );
    return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${this.qualify(ref)} (${cols.join(', ')})`;
  }
}

// ─── MySQL ────────────────────────────────────────────────────────────────

export class MySQLDialect extends Dialect {
  readonly engine = ClusterType.MYSQL;
  readonly defaultSchema = null;

  quote(id: string) {
    return `\`${id.replaceAll('`', '``')}\``;
  }
  param() {
    return '?';
  }

  tablesQuery(): Statement {
    return {
      sql: "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      params: [],
    };
  }

  columnsQuery(table?: string): Statement {
    return {
      sql: `SELECT NULL AS \`schema\`, c.TABLE_NAME AS \`table\`, c.TABLE_NAME AS tableName, c.COLUMN_NAME AS name,
          c.DATA_TYPE AS type, c.COLUMN_TYPE AS fullType,
          c.IS_NULLABLE AS nullable, c.COLUMN_DEFAULT AS defaultValue, IF(c.COLUMN_KEY = 'PRI', 'PRI', '') AS columnKey,
          c.EXTRA AS extra, c.GENERATION_EXPRESSION AS generationExpression, c.ORDINAL_POSITION AS ordinal,
          fk.referencedTable, fk.referencedColumn
        FROM information_schema.COLUMNS c
        JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
        LEFT JOIN (
          SELECT k.TABLE_NAME, k.COLUMN_NAME, MIN(k.REFERENCED_TABLE_NAME) AS referencedTable, MIN(k.REFERENCED_COLUMN_NAME) AS referencedColumn
          FROM information_schema.KEY_COLUMN_USAGE k
          WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
          GROUP BY k.TABLE_NAME, k.COLUMN_NAME
        ) fk ON fk.TABLE_NAME = c.TABLE_NAME AND fk.COLUMN_NAME = c.COLUMN_NAME
        WHERE c.TABLE_SCHEMA = DATABASE()${table !== undefined ? ' AND c.TABLE_NAME = ?' : ''}
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      params: table !== undefined ? [table] : [],
    };
  }

  indexesQuery(table?: string): Statement {
    return {
      sql: `SELECT NULL AS \`schema\`, s.TABLE_NAME AS \`table\`, s.TABLE_NAME AS tableName, s.INDEX_NAME AS name,
          MIN(s.NON_UNIQUE) = 0 AS isUnique, s.INDEX_NAME = 'PRIMARY' AS isPrimary, 0 AS isConstraint,
          GROUP_CONCAT(s.COLUMN_NAME ORDER BY s.SEQ_IN_INDEX SEPARATOR '${US}') AS cols,
          GROUP_CONCAT(IFNULL(s.SUB_PART, '') ORDER BY s.SEQ_IN_INDEX SEPARATOR '${US}') AS prefixes,
          GROUP_CONCAT(IFNULL(s.COLLATION, 'A') ORDER BY s.SEQ_IN_INDEX SEPARATOR '${US}') AS descending,
          SUM(s.COLUMN_NAME IS NULL) > 0 AS isExpression,
          IF(MIN(s.INDEX_TYPE) IN ('FULLTEXT', 'SPATIAL'), MIN(s.INDEX_TYPE), NULL) AS method
        FROM information_schema.STATISTICS s
        WHERE s.TABLE_SCHEMA = DATABASE()${table !== undefined ? ' AND s.TABLE_NAME = ?' : ''}
        GROUP BY s.TABLE_NAME, s.INDEX_NAME
        ORDER BY s.TABLE_NAME, s.INDEX_NAME`,
      params: table !== undefined ? [table] : [],
    };
  }

  foreignKeysQuery(table?: string): Statement {
    return {
      sql: `SELECT NULL AS \`schema\`, k.TABLE_NAME AS \`table\`, k.TABLE_NAME AS tableName, k.CONSTRAINT_NAME AS name,
          GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR '${US}') AS cols,
          NULL AS refSchema, MIN(k.REFERENCED_TABLE_NAME) AS refTable,
          GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR '${US}') AS refCols,
          MIN(r.DELETE_RULE) AS onDelete, MIN(r.UPDATE_RULE) AS onUpdate
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r
          ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_SCHEMA = DATABASE()${table !== undefined ? ' AND k.TABLE_NAME = ?' : ''}
        GROUP BY k.TABLE_NAME, k.CONSTRAINT_NAME
        ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME`,
      params: table !== undefined ? [table] : [],
    };
  }

  protected normalizeRaw(r: Row): Omit<ColumnInfo, 'kind'> {
    const extra = toText(r.extra);
    const onUpdate = /on update (current_timestamp(\(\d*\))?)/i.exec(extra);
    const generated = /\b(VIRTUAL|STORED) GENERATED\b/i.test(extra);
    return {
      schema: null,
      table: toText(r.table),
      tableName: toText(r.tableName),
      name: toText(r.name),
      type: toText(r.type).toLowerCase(),
      fullType: toText(r.fullType),
      nullable: r.nullable === 'YES' ? 'YES' : 'NO',
      defaultValue:
        r.defaultValue === null || r.defaultValue === undefined
          ? null
          : /DEFAULT_GENERATED/i.test(extra)
            ? `(${toText(r.defaultValue)})` // expression default
            : toText(r.defaultValue),
      columnKey: r.columnKey === 'PRI' ? 'PRI' : '',
      isAutoIncrement: /auto_increment/i.test(extra),
      isGenerated: generated,
      generationExpression: generated ? toText(r.generationExpression) : null,
      onUpdate: onUpdate ? `ON UPDATE ${onUpdate[1].toUpperCase()}` : null,
      referencedTable: (r.referencedTable as string) ?? null,
      referencedColumn: (r.referencedColumn as string) ?? null,
      ordinal: Number(r.ordinal),
    };
  }

  protected defaultClause(column: ColumnInfo, source: ClusterType) {
    const clause = super.defaultClause(column, source);
    // DATETIME(n) needs CURRENT_TIMESTAMP(n) with the same precision.
    const precision = /^(datetime|timestamp)\((\d)\)/i.exec(
      this.mapType(column, source),
    );
    if (
      source !== this.engine &&
      clause === 'DEFAULT CURRENT_TIMESTAMP' &&
      precision
    ) {
      return `DEFAULT CURRENT_TIMESTAMP(${precision[2]})`;
    }
    return clause;
  }

  protected sameEngineDefault(column: ColumnInfo, def: string) {
    if (def.startsWith('(')) {
      const inner = def.slice(1, -1);
      return NOW_FUNCS.test(inner) ? `DEFAULT ${inner}` : `DEFAULT ${def}`;
    }
    if (NOW_FUNCS.test(def)) return `DEFAULT ${def}`;
    return `DEFAULT ${this.stringLiteral(def)}`;
  }

  pageClause({ orderBy, limit, offset }: PagingOptions) {
    return `${orderBy ? ` ORDER BY ${orderBy}` : ''} LIMIT ${limit} OFFSET ${offset}`;
  }
  updateOne(ref: TableRef, set: string, where: string) {
    return `UPDATE ${this.qualify(ref)} SET ${set} WHERE ${where} LIMIT 1`;
  }
  deleteOne(ref: TableRef, where: string) {
    return `DELETE FROM ${this.qualify(ref)} WHERE ${where} LIMIT 1`;
  }
  insert(ref: TableRef, columns: string[], _returning: boolean, offset = 0) {
    if (columns.length === 0)
      return `INSERT INTO ${this.qualify(ref)} () VALUES ()`;
    return super.insert(ref, columns, false, offset);
  }
  insertIfMissing(ref: TableRef, columns: string[], pkColumns: string[]) {
    const pk = this.quote(pkColumns[0]);
    return `${this.insert(ref, columns, false)} ON DUPLICATE KEY UPDATE ${pk} = ${pk}`;
  }

  mapType(column: ColumnInfo, source: ClusterType): string {
    if (source === this.engine) return column.fullType;
    const { len, scale } = lengthOf(column);
    switch (column.kind) {
      case 'json':
      case 'array':
        return 'json';
      case 'binary':
        return len && len <= 65535 && /binary/i.test(column.type)
          ? `varbinary(${len})`
          : 'longblob';
      case 'boolean':
        return 'tinyint(1)';
      case 'integer':
        return 'int';
      case 'bigint':
        return 'bigint';
      case 'decimal':
        return len
          ? `decimal(${Math.min(len, 65)},${Math.min(scale ?? 0, 30)})`
          : 'decimal(65,30)';
      case 'float':
        return 'double';
      case 'date':
        return 'date';
      case 'datetime':
      case 'datetimetz':
        return 'datetime(6)';
      case 'time':
        return 'time(6)';
      case 'uuid':
        return 'char(36)';
      case 'text':
        if (isCharType(column) && len && len <= 16383) return `varchar(${len})`;
        return column.columnKey === 'PRI' ? 'varchar(255)' : 'longtext';
      default:
        return column.columnKey === 'PRI' ? 'varchar(255)' : 'longtext';
    }
  }

  alterColumnType(ref: TableRef, column: ColumnInfo, source: ClusterType) {
    return `ALTER TABLE ${this.qualify(ref)} MODIFY COLUMN ${this.columnDefinition({ ...column, columnKey: '' }, source)}`;
  }

  createIndex(
    ref: TableRef,
    index: IndexInfo,
    source: ClusterType,
    targetColumns: ColumnInfo[],
  ) {
    if (index.primary || index.columns.length === 0) return null;
    if (index.expression && source !== this.engine) return null;
    const byName = new Map(targetColumns.map((c) => [c.name, c]));
    const parts: string[] = [];
    for (const [i, col] of index.columns.entries()) {
      const target = byName.get(col);
      if (target?.kind === 'json') return null; // JSON can't be indexed directly
      // TEXT/BLOB keys need a prefix length in MySQL.
      const prefix =
        index.prefixes[i] ??
        (target && /text|blob/i.test(target.fullType) ? 191 : null);
      parts.push(
        `${this.quote(col)}${prefix ? `(${prefix})` : ''}${index.descending[i] ? ' DESC' : ''}`,
      );
    }
    const kind =
      source === this.engine && index.method
        ? `${index.method} `
        : index.unique
          ? 'UNIQUE '
          : '';
    return `CREATE ${kind}INDEX ${this.quote(this.indexName(ref, index, source))} ON ${this.qualify(ref)} (${parts.join(', ')})`;
  }

  protected autoIncrementClause() {
    return 'AUTO_INCREMENT';
  }
  stringLiteral(value: string) {
    return mysql.escape(value);
  }
  binaryLiteral(hex: string) {
    return `X'${hex}'`;
  }
  booleanLiteral(value: boolean) {
    return value ? '1' : '0';
  }
  protected createTableWrapper(ref: TableRef, body: string) {
    return `CREATE TABLE IF NOT EXISTS ${this.qualify(ref)} ${body} ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
  }
}

// ─── PostgreSQL ───────────────────────────────────────────────────────────

const PG_USER_SCHEMA = (column: string) =>
  `${column} <> 'information_schema' AND ${column} !~ '^pg_'`;
const PG_DISPLAY = (schema: string, table: string) =>
  `CASE WHEN ${schema} = 'public' THEN ${table}::text ELSE ${schema} || '.' || ${table} END`;

export class PostgresDialect extends Dialect {
  readonly engine = ClusterType.POSTGRES;
  readonly defaultSchema = 'public';

  quote(id: string) {
    return `"${id.replaceAll('"', '""')}"`;
  }
  param(n: number) {
    return `$${n}`;
  }

  createSchema(schema: string) {
    return `CREATE SCHEMA IF NOT EXISTS ${this.quote(schema)}`;
  }

  tablesQuery(): Statement {
    return {
      sql: `SELECT ${PG_DISPLAY('table_schema', 'table_name')} AS name FROM information_schema.tables
        WHERE table_type = 'BASE TABLE' AND ${PG_USER_SCHEMA('table_schema')}
        ORDER BY table_schema <> 'public', name`,
      params: [],
    };
  }

  columnsQuery(table?: string): Statement {
    return {
      sql: `SELECT n.nspname AS "schema", c.relname AS "table", ${PG_DISPLAY('n.nspname', 'c.relname')} AS "tableName",
          a.attname AS name, cols.data_type AS type,
          format_type(a.atttypid, a.atttypmod) AS "fullType", cols.udt_name AS "udtName",
          cols.is_nullable AS nullable, cols.column_default AS "defaultValue",
          CASE WHEN EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indrelid = c.oid AND ix.indisprimary AND a.attnum = ANY (ix.indkey::int2[]))
            THEN 'PRI' ELSE '' END AS "columnKey",
          (cols.is_identity = 'YES' OR COALESCE(cols.column_default, '') LIKE 'nextval(%') AS "isAutoIncrement",
          (cols.is_generated = 'ALWAYS') AS "isGenerated", cols.generation_expression AS "generationExpression",
          cols.ordinal_position AS ordinal,
          fk.ref_table AS "referencedTable", fk.ref_column AS "referencedColumn",
          (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS "enumValues"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        JOIN information_schema.columns cols ON cols.table_schema = n.nspname AND cols.table_name = c.relname AND cols.column_name = a.attname
        LEFT JOIN LATERAL (
          SELECT ${PG_DISPLAY('rn.nspname', 'rc.relname')} AS ref_table, ra.attname AS ref_column
          FROM pg_constraint con
          JOIN pg_class rc ON rc.oid = con.confrelid
          JOIN pg_namespace rn ON rn.oid = rc.relnamespace
          JOIN LATERAL unnest(con.conkey, con.confkey) AS k(attnum, refnum) ON true
          JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refnum
          WHERE con.contype = 'f' AND con.conrelid = c.oid AND k.attnum = a.attnum
          LIMIT 1
        ) fk ON true
        WHERE c.relkind IN ('r', 'p') AND ${PG_USER_SCHEMA('n.nspname')}${table !== undefined ? ` AND ${PG_DISPLAY('n.nspname', 'c.relname')} = $1` : ''}
        ORDER BY "tableName", cols.ordinal_position`,
      params: table !== undefined ? [table] : [],
    };
  }

  indexesQuery(table?: string): Statement {
    return {
      sql: `SELECT n.nspname AS "schema", t.relname AS "table", ${PG_DISPLAY('n.nspname', 't.relname')} AS "tableName",
          i.relname AS name, ix.indisunique AS "isUnique", ix.indisprimary AS "isPrimary",
          EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid AND con.contype = 'u') AS "isConstraint",
          ARRAY(SELECT a.attname FROM unnest(ix.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols,
          ARRAY(SELECT CASE WHEN (o.opt & 1) = 1 THEN '1' ELSE '0' END FROM unnest(ix.indoption::int2[]) WITH ORDINALITY o(opt, ord) ORDER BY o.ord)::text[] AS descending,
          (ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL OR 0 = ANY (ix.indkey::int2[])) AS "isExpression",
          pg_get_indexdef(ix.indexrelid) AS definition
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relkind IN ('r', 'p') AND ${PG_USER_SCHEMA('n.nspname')}${table !== undefined ? ` AND ${PG_DISPLAY('n.nspname', 't.relname')} = $1` : ''}
        ORDER BY 3, 4`,
      params: table !== undefined ? [table] : [],
    };
  }

  foreignKeysQuery(table?: string): Statement {
    return {
      sql: `SELECT n.nspname AS "schema", c.relname AS "table", ${PG_DISPLAY('n.nspname', 'c.relname')} AS "tableName",
          con.conname AS name,
          ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS cols,
          rn.nspname AS "refSchema", rc.relname AS "refTable",
          ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS "refCols",
          con.confdeltype::text AS "onDelete", con.confupdtype::text AS "onUpdate"
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_class rc ON rc.oid = con.confrelid
        JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE con.contype = 'f' AND ${PG_USER_SCHEMA('n.nspname')}${table !== undefined ? ` AND ${PG_DISPLAY('n.nspname', 'c.relname')} = $1` : ''}
        ORDER BY 3, 4`,
      params: table !== undefined ? [table] : [],
    };
  }

  protected normalizeRaw(r: Row): Omit<ColumnInfo, 'kind'> {
    return {
      schema: toText(r.schema),
      table: toText(r.table),
      tableName: toText(r.tableName),
      name: toText(r.name),
      type: toText(r.type).toLowerCase(),
      fullType: toText(r.fullType),
      udtName: toText(r.udtName),
      nullable: r.nullable === 'YES' ? 'YES' : 'NO',
      defaultValue: (r.defaultValue as string) ?? null,
      columnKey: r.columnKey === 'PRI' ? 'PRI' : '',
      isAutoIncrement: truthy(r.isAutoIncrement),
      isGenerated: truthy(r.isGenerated),
      generationExpression: (r.generationExpression as string) ?? null,
      onUpdate: null,
      referencedTable: (r.referencedTable as string) ?? null,
      referencedColumn: (r.referencedColumn as string) ?? null,
      enumValues: (r.enumValues as string) ?? null,
      ordinal: Number(r.ordinal),
    };
  }

  equals(column: ColumnInfo, placeholder: string | null) {
    if (placeholder !== null && column.kind === 'json') {
      return `${this.quote(column.name)}::jsonb = ${placeholder}::jsonb`;
    }
    return super.equals(column, placeholder);
  }

  like(column: ColumnInfo, placeholder: string, negate: boolean) {
    const col =
      column.kind === 'text'
        ? this.quote(column.name)
        : `${this.quote(column.name)}::text`;
    return `${col} ${negate ? 'NOT ILIKE' : 'ILIKE'} ${placeholder}`;
  }

  pageClause({ orderBy, limit, offset }: PagingOptions) {
    return `${orderBy ? ` ORDER BY ${orderBy}` : ''} LIMIT ${limit} OFFSET ${offset}`;
  }
  updateOne(ref: TableRef, set: string, where: string) {
    const t = this.qualify(ref);
    return `UPDATE ${t} SET ${set} WHERE ctid = (SELECT ctid FROM ${t} WHERE ${where} LIMIT 1)`;
  }
  deleteOne(ref: TableRef, where: string) {
    const t = this.qualify(ref);
    return `DELETE FROM ${t} WHERE ctid = (SELECT ctid FROM ${t} WHERE ${where} LIMIT 1)`;
  }
  insertIfMissing(ref: TableRef, columns: string[], _pk: string[], offset = 0) {
    return `${this.insert(ref, columns, false, offset)} ON CONFLICT DO NOTHING`;
  }

  mapType(column: ColumnInfo, source: ClusterType): string {
    if (source === this.engine) return column.fullType;
    const { len, scale } = lengthOf(column);
    switch (column.kind) {
      case 'json':
      case 'array':
        return 'jsonb';
      case 'binary':
        return 'bytea';
      case 'boolean':
        return 'boolean';
      case 'integer':
        return 'integer';
      case 'bigint':
        return 'bigint';
      case 'decimal':
        return len ? `numeric(${len},${scale ?? 0})` : 'numeric';
      case 'float':
        return 'double precision';
      case 'date':
        return 'date';
      case 'datetime':
        return 'timestamp';
      case 'datetimetz':
        return 'timestamptz';
      case 'time':
        return 'time';
      case 'uuid':
        return 'uuid';
      case 'text':
        return isCharType(column) && len ? `varchar(${len})` : 'text';
      default:
        return 'text';
    }
  }

  alterColumnType(ref: TableRef, column: ColumnInfo, source: ClusterType) {
    const type = this.mapType(column, source);
    const col = this.quote(column.name);
    return `ALTER TABLE ${this.qualify(ref)} ALTER COLUMN ${col} TYPE ${type} USING ${col}::${type}`;
  }

  createIndex(
    ref: TableRef,
    index: IndexInfo,
    source: ClusterType,
    targetColumns: ColumnInfo[],
  ) {
    if (index.primary) return null;
    if (source === this.engine && index.definition) {
      // Same engine and same table name: reuse the exact definition.
      return index.definition.replace(
        /^CREATE (UNIQUE )?INDEX /,
        'CREATE $1INDEX IF NOT EXISTS ',
      );
    }
    const ddl = super.createIndex(ref, index, source, targetColumns);
    return (
      ddl?.replace(
        /^CREATE (UNIQUE )?INDEX /,
        'CREATE $1INDEX IF NOT EXISTS ',
      ) ?? null
    );
  }

  protected sameEngineDefault(column: ColumnInfo, def: string) {
    return /^nextval\(/i.test(def) ? '' : `DEFAULT ${def}`;
  }
  protected autoIncrementClause() {
    // Identity instead of a serial: the original sequence won't exist in the target.
    return 'GENERATED BY DEFAULT AS IDENTITY';
  }
  stringLiteral(value: string) {
    return `'${value.replaceAll("'", "''")}'`;
  }
  binaryLiteral(hex: string) {
    return `decode('${hex}', 'hex')`;
  }
  booleanLiteral(value: boolean) {
    return value ? 'TRUE' : 'FALSE';
  }
  protected createTableWrapper(ref: TableRef, body: string) {
    return `CREATE TABLE IF NOT EXISTS ${this.qualify(ref)} ${body}`;
  }

  literal(value: unknown, column?: ColumnInfo): string {
    if (column?.kind === 'array' && Array.isArray(value)) {
      return this.stringLiteral(toPgArrayLiteral(value));
    }
    return super.literal(value, column);
  }

  /** Statement that moves an identity/serial sequence past the copied rows. */
  resetSequence(ref: TableRef, column: string): string {
    const t = this.qualify(ref);
    const c = this.quote(column);
    return `SELECT setval(pg_get_serial_sequence(${this.stringLiteral(t)}, ${this.stringLiteral(column)}), COALESCE(MAX(${c}), 1), MAX(${c}) IS NOT NULL) FROM ${t}`;
  }
}

export function toPgArrayLiteral(values: unknown[]): string {
  const items = values.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return toPgArrayLiteral(v);
    const s = toText(v);
    return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  });
  return `{${items.join(',')}}`;
}

// ─── SQL Server ───────────────────────────────────────────────────────────

const MS_DISPLAY = (schema: string, table: string) =>
  `CASE WHEN ${schema} = 'dbo' THEN ${table} ELSE ${schema} + '.' + ${table} END`;

export class MSSQLDialect extends Dialect {
  readonly engine = ClusterType.MSSQL;
  readonly defaultSchema = 'dbo';

  quote(id: string) {
    return `[${id.replaceAll(']', ']]')}]`;
  }
  param(n: number) {
    return `@p${n}`;
  }

  createSchema(schema: string) {
    const name = schema.replaceAll("'", "''");
    return `IF SCHEMA_ID(N'${name}') IS NULL EXEC(N'CREATE SCHEMA ${this.quote(schema).replaceAll("'", "''")}')`;
  }

  tablesQuery(): Statement {
    return {
      sql: `SELECT ${MS_DISPLAY('TABLE_SCHEMA', 'TABLE_NAME')} AS name FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_CATALOG = DB_NAME()
        ORDER BY CASE WHEN TABLE_SCHEMA = 'dbo' THEN 0 ELSE 1 END, name`,
      params: [],
    };
  }

  columnsQuery(table?: string): Statement {
    return {
      sql: `SELECT c.TABLE_SCHEMA AS [schema], c.TABLE_NAME AS [table], ${MS_DISPLAY('c.TABLE_SCHEMA', 'c.TABLE_NAME')} AS tableName,
          c.COLUMN_NAME AS name, c.DATA_TYPE AS type,
          c.CHARACTER_MAXIMUM_LENGTH AS charLength, c.NUMERIC_PRECISION AS numPrecision, c.NUMERIC_SCALE AS numScale,
          c.DATETIME_PRECISION AS dtPrecision, c.IS_NULLABLE AS nullable, c.COLUMN_DEFAULT AS defaultValue,
          c.ORDINAL_POSITION AS ordinal,
          CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'PRI' ELSE '' END AS columnKey,
          COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') AS isIdentity,
          cc.definition AS computedDefinition,
          fk.referencedTable, fk.referencedColumn
        FROM INFORMATION_SCHEMA.COLUMNS c
        JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
        LEFT JOIN (
          SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON ku.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND ku.TABLE_SCHEMA = tc.TABLE_SCHEMA
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
        LEFT JOIN sys.computed_columns cc
          ON cc.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)) AND cc.name = c.COLUMN_NAME
        LEFT JOIN (
          SELECT OBJECT_SCHEMA_NAME(fkc.parent_object_id) AS sch, OBJECT_NAME(fkc.parent_object_id) AS tbl, pc.name AS col,
            MIN(${MS_DISPLAY('OBJECT_SCHEMA_NAME(fkc.referenced_object_id)', 'OBJECT_NAME(fkc.referenced_object_id)')}) AS referencedTable,
            MIN(rc.name) AS referencedColumn
          FROM sys.foreign_key_columns fkc
          JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
          JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
          GROUP BY fkc.parent_object_id, pc.name
        ) fk ON fk.sch = c.TABLE_SCHEMA AND fk.tbl = c.TABLE_NAME AND fk.col = c.COLUMN_NAME
        WHERE c.TABLE_CATALOG = DB_NAME()${table !== undefined ? ` AND ${MS_DISPLAY('c.TABLE_SCHEMA', 'c.TABLE_NAME')} = @p1` : ''}
        ORDER BY tableName, c.ORDINAL_POSITION`,
      params: table !== undefined ? [table] : [],
    };
  }

  indexesQuery(table?: string): Statement {
    return {
      sql: `SELECT s.name AS [schema], t.name AS [table], ${MS_DISPLAY('s.name', 't.name')} AS tableName,
          i.name AS name, i.is_unique AS isUnique, i.is_primary_key AS isPrimary, i.is_unique_constraint AS isConstraint,
          CASE WHEN i.type_desc IN ('CLUSTERED', 'NONCLUSTERED') THEN i.type_desc END AS method,
          CASE WHEN i.type_desc NOT IN ('CLUSTERED', 'NONCLUSTERED') THEN 1 ELSE 0 END AS isExpression,
          i.filter_definition AS whereClause,
          STRING_AGG(CASE WHEN ic.is_included_column = 0 THEN c.name END, N'${US}') WITHIN GROUP (ORDER BY ic.key_ordinal) AS cols,
          STRING_AGG(CASE WHEN ic.is_included_column = 0 THEN CAST(ic.is_descending_key AS NVARCHAR(1)) END, N'${US}') WITHIN GROUP (ORDER BY ic.key_ordinal) AS descending,
          STRING_AGG(CASE WHEN ic.is_included_column = 1 THEN c.name END, N'${US}') AS include
        FROM sys.indexes i
        JOIN sys.tables t ON t.object_id = i.object_id
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.type > 0 AND i.is_hypothetical = 0 AND t.is_ms_shipped = 0${table !== undefined ? ` AND ${MS_DISPLAY('s.name', 't.name')} = @p1` : ''}
        GROUP BY s.name, t.name, i.name, i.is_unique, i.is_primary_key, i.is_unique_constraint, i.type_desc, i.filter_definition
        ORDER BY tableName, i.name`,
      params: table !== undefined ? [table] : [],
    };
  }

  foreignKeysQuery(table?: string): Statement {
    const parent = MS_DISPLAY(
      'OBJECT_SCHEMA_NAME(fk.parent_object_id)',
      'OBJECT_NAME(fk.parent_object_id)',
    );
    return {
      sql: `SELECT OBJECT_SCHEMA_NAME(fk.parent_object_id) AS [schema], OBJECT_NAME(fk.parent_object_id) AS [table],
          ${parent} AS tableName, fk.name AS name,
          STRING_AGG(pc.name, N'${US}') WITHIN GROUP (ORDER BY fkc.constraint_column_id) AS cols,
          OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS refSchema, OBJECT_NAME(fk.referenced_object_id) AS refTable,
          STRING_AGG(rc.name, N'${US}') WITHIN GROUP (ORDER BY fkc.constraint_column_id) AS refCols,
          fk.delete_referential_action_desc AS onDelete, fk.update_referential_action_desc AS onUpdate
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
        JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
        JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        ${table !== undefined ? `WHERE ${parent} = @p1` : ''}
        GROUP BY fk.name, fk.parent_object_id, fk.referenced_object_id, fk.delete_referential_action_desc, fk.update_referential_action_desc
        ORDER BY tableName, fk.name`,
      params: table !== undefined ? [table] : [],
    };
  }

  protected normalizeRaw(r: Row): Omit<ColumnInfo, 'kind'> {
    const type = toText(r.type).toLowerCase();
    let fullType = type;
    const len = r.charLength as number | null;
    if (len !== null && len !== undefined && /char|binary/.test(type)) {
      fullType = `${type}(${len === -1 ? 'max' : len})`;
    } else if (type === 'decimal' || type === 'numeric') {
      fullType = `${type}(${toText(r.numPrecision)},${toText(r.numScale)})`;
    } else if (
      /^(datetime2|datetimeoffset|time)$/.test(type) &&
      r.dtPrecision !== null
    ) {
      fullType = `${type}(${toText(r.dtPrecision)})`;
    }
    const computed = (r.computedDefinition as string) ?? null;
    return {
      schema: toText(r.schema),
      table: toText(r.table),
      tableName: toText(r.tableName),
      name: toText(r.name),
      type,
      fullType,
      nullable: r.nullable === 'YES' ? 'YES' : 'NO',
      defaultValue: (r.defaultValue as string) ?? null,
      columnKey: r.columnKey === 'PRI' ? 'PRI' : '',
      isAutoIncrement: Number(r.isIdentity) === 1,
      isGenerated: computed !== null,
      generationExpression: computed,
      onUpdate: null,
      referencedTable: (r.referencedTable as string) ?? null,
      referencedColumn: (r.referencedColumn as string) ?? null,
      ordinal: Number(r.ordinal),
    };
  }

  protected generatedClause(column: ColumnInfo) {
    return `AS ${column.generationExpression}`;
  }

  pageClause({ orderBy, limit, offset }: PagingOptions) {
    return ` ORDER BY ${orderBy || '(SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  updateOne(ref: TableRef, set: string, where: string) {
    return `UPDATE TOP (1) ${this.qualify(ref)} SET ${set} WHERE ${where}`;
  }
  deleteOne(ref: TableRef, where: string) {
    return `DELETE TOP (1) FROM ${this.qualify(ref)} WHERE ${where}`;
  }
  insert(ref: TableRef, columns: string[], returning: boolean, offset = 0) {
    const t = this.qualify(ref);
    const output = returning ? ' OUTPUT INSERTED.*' : '';
    if (columns.length === 0) return `INSERT INTO ${t}${output} DEFAULT VALUES`;
    const cols = columns.map((c) => this.quote(c)).join(', ');
    const values = columns.map((_, i) => this.param(offset + i + 1)).join(', ');
    return `INSERT INTO ${t} (${cols})${output} VALUES (${values})`;
  }
  insertIfMissing(
    ref: TableRef,
    columns: string[],
    pkColumns: string[],
    offset = 0,
  ) {
    const t = this.qualify(ref);
    const cols = columns.map((c) => this.quote(c)).join(', ');
    const values = columns.map((_, i) => this.param(offset + i + 1)).join(', ');
    const match = pkColumns
      .map(
        (pk) =>
          `${this.quote(pk)} = ${this.param(offset + columns.indexOf(pk) + 1)}`,
      )
      .join(' AND ');
    return `INSERT INTO ${t} (${cols}) SELECT ${values} WHERE NOT EXISTS (SELECT 1 FROM ${t} WHERE ${match})`;
  }

  mapType(column: ColumnInfo, source: ClusterType): string {
    if (source === this.engine) return column.fullType;
    const { len, scale } = lengthOf(column);
    const isPk = column.columnKey === 'PRI';
    switch (column.kind) {
      case 'json':
      case 'array':
        return 'nvarchar(max)';
      case 'binary':
        return isPk ? 'varbinary(900)' : 'varbinary(max)';
      case 'boolean':
        return 'bit';
      case 'integer':
        return 'int';
      case 'bigint':
        return 'bigint';
      case 'decimal':
        return len
          ? `decimal(${Math.min(len, 38)},${Math.min(scale ?? 0, 38)})`
          : 'decimal(38,10)';
      case 'float':
        return 'float';
      case 'date':
        return 'date';
      case 'datetime':
        return 'datetime2';
      case 'datetimetz':
        return 'datetimeoffset';
      case 'time':
        return 'time';
      case 'uuid':
        return 'uniqueidentifier';
      case 'text':
        if (isCharType(column) && len && len <= 4000) return `nvarchar(${len})`;
        return isPk ? 'nvarchar(450)' : 'nvarchar(max)';
      default:
        return isPk ? 'nvarchar(450)' : 'nvarchar(max)';
    }
  }

  alterColumnType(ref: TableRef, column: ColumnInfo, source: ClusterType) {
    const nullability = column.nullable === 'NO' ? ' NOT NULL' : ' NULL';
    return `ALTER TABLE ${this.qualify(ref)} ALTER COLUMN ${this.quote(column.name)} ${this.mapType(column, source)}${nullability}`;
  }

  protected referentialAction(a: ReferentialAction) {
    return a === 'RESTRICT' ? 'NO ACTION' : a; // SQL Server has no RESTRICT
  }

  createIndex(
    ref: TableRef,
    index: IndexInfo,
    source: ClusterType,
    targetColumns: ColumnInfo[],
  ) {
    if (index.primary || index.columns.length === 0) return null;
    if (index.expression) return null; // columnstore, XML and spatial indexes
    const byName = new Map(targetColumns.map((c) => [c.name, c]));
    // (max) columns can't be index keys in SQL Server.
    if (
      index.columns.some((c) =>
        /\(max\)|^(n?text|image|xml)$/i.test(byName.get(c)?.fullType ?? ''),
      )
    ) {
      return null;
    }
    const name = this.quote(this.indexName(ref, index, source));
    const t = this.qualify(ref);
    const cols = index.columns
      .map((c, i) => `${this.quote(c)}${index.descending[i] ? ' DESC' : ''}`)
      .join(', ');
    const same = source === this.engine;
    if (same && index.constraint) {
      return `ALTER TABLE ${t} ADD CONSTRAINT ${name} UNIQUE ${index.method ?? 'NONCLUSTERED'} (${cols})`;
    }
    const method = same && index.method ? `${index.method} ` : '';
    const include =
      same && index.include.length
        ? ` INCLUDE (${index.include.map((c) => this.quote(c)).join(', ')})`
        : '';
    const where = same && index.where ? ` WHERE ${index.where}` : '';
    return `CREATE ${index.unique ? 'UNIQUE ' : ''}${method}INDEX ${name} ON ${t} (${cols})${include}${where}`;
  }

  protected autoIncrementClause() {
    return 'IDENTITY(1,1)';
  }
  stringLiteral(value: string) {
    return `N'${value.replaceAll("'", "''")}'`;
  }
  binaryLiteral(hex: string) {
    return `0x${hex}`;
  }
  booleanLiteral(value: boolean) {
    return value ? '1' : '0';
  }
  protected createTableWrapper(ref: TableRef, body: string) {
    const name = this.qualify(ref).replaceAll("'", "''");
    return `IF OBJECT_ID(N'${name}', N'U') IS NULL CREATE TABLE ${this.qualify(ref)} ${body}`;
  }
  identityInsert(ref: TableRef, on: boolean) {
    return `SET IDENTITY_INSERT ${this.qualify(ref)} ${on ? 'ON' : 'OFF'}`;
  }
}

// ─── SQLite ───────────────────────────────────────────────────────────────

export class SQLiteDialect extends Dialect {
  readonly engine = ClusterType.SQLITE;
  readonly defaultSchema = null;

  quote(id: string) {
    return `"${id.replaceAll('"', '""')}"`;
  }
  param() {
    return '?';
  }

  tablesQuery(): Statement {
    return {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      params: [],
    };
  }

  columnsQuery(table?: string): Statement {
    return {
      sql: `SELECT NULL AS "schema", m.name AS "table", m.name AS tableName, p.name AS name, p.type AS type,
          p."notnull" AS "isNotNull", p.dflt_value AS defaultValue, p.pk AS pk, p.cid AS ordinal, p.hidden AS hidden,
          (SELECT COUNT(*) FROM pragma_table_info(m.name) x WHERE x.pk > 0) AS pkCount,
          (SELECT f."table" FROM pragma_foreign_key_list(m.name) f WHERE f."from" = p.name LIMIT 1) AS referencedTable,
          (SELECT f."to" FROM pragma_foreign_key_list(m.name) f WHERE f."from" = p.name LIMIT 1) AS referencedColumn
        FROM sqlite_master m JOIN pragma_table_xinfo(m.name) p
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'${table !== undefined ? ' AND m.name = ?' : ''}
        ORDER BY m.name, p.cid`,
      params: table !== undefined ? [table] : [],
    };
  }

  indexesQuery(table?: string): Statement {
    return {
      sql: `SELECT NULL AS "schema", m.name AS "table", m.name AS tableName, il.name AS name,
          il."unique" AS isUnique, il.origin = 'pk' AS isPrimary, il.origin = 'u' AS isConstraint,
          (SELECT group_concat(name, char(31)) FROM (SELECT name FROM pragma_index_info(il.name) ORDER BY seqno)) AS cols,
          (il.partial OR (SELECT COUNT(*) FROM pragma_index_info(il.name) WHERE name IS NULL) > 0) AS isExpression,
          (SELECT s.sql FROM sqlite_master s WHERE s.type = 'index' AND s.name = il.name) AS definition
        FROM sqlite_master m JOIN pragma_index_list(m.name) il
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'${table !== undefined ? ' AND m.name = ?' : ''}
        ORDER BY m.name, il.name`,
      params: table !== undefined ? [table] : [],
    };
  }

  foreignKeysQuery(table?: string): Statement {
    return {
      sql: `SELECT NULL AS "schema", m.name AS "table", m.name AS tableName, 'fk_' || m.name || '_' || f.id AS name,
          group_concat(f."from", char(31)) AS cols, NULL AS refSchema, f."table" AS refTable,
          group_concat(COALESCE(f."to", ''), char(31)) AS refCols, f.on_delete AS onDelete, f.on_update AS onUpdate
        FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'${table !== undefined ? ' AND m.name = ?' : ''}
        GROUP BY m.name, f.id
        ORDER BY m.name, f.id`,
      params: table !== undefined ? [table] : [],
    };
  }

  protected normalizeRaw(r: Row): Omit<ColumnInfo, 'kind'> {
    const type = toText(r.type);
    const pk = Number(r.pk) > 0;
    return {
      schema: null,
      table: toText(r.table),
      tableName: toText(r.tableName),
      name: toText(r.name),
      type: type.toLowerCase(),
      fullType: type,
      nullable: Number(r.isNotNull) === 1 || pk ? 'NO' : 'YES',
      defaultValue: (r.defaultValue as string) ?? null,
      columnKey: pk ? 'PRI' : '',
      // A lone INTEGER PRIMARY KEY is an alias for rowid and auto-assigns.
      isAutoIncrement:
        pk && Number(r.pkCount) === 1 && type.toUpperCase() === 'INTEGER',
      isGenerated: Number(r.hidden) >= 2,
      generationExpression: null,
      onUpdate: null,
      referencedTable: (r.referencedTable as string) ?? null,
      referencedColumn: (r.referencedColumn as string) ?? null,
      ordinal: Number(r.ordinal) + 1,
    };
  }

  pageClause({ orderBy, limit, offset }: PagingOptions) {
    return `${orderBy ? ` ORDER BY ${orderBy}` : ''} LIMIT ${limit} OFFSET ${offset}`;
  }
  updateOne(ref: TableRef, set: string, where: string) {
    const t = this.qualify(ref);
    return `UPDATE ${t} SET ${set} WHERE rowid = (SELECT rowid FROM ${t} WHERE ${where} LIMIT 1)`;
  }
  deleteOne(ref: TableRef, where: string) {
    const t = this.qualify(ref);
    return `DELETE FROM ${t} WHERE rowid = (SELECT rowid FROM ${t} WHERE ${where} LIMIT 1)`;
  }
  insertIfMissing(ref: TableRef, columns: string[]) {
    return this.insert(ref, columns, false).replace(
      /^INSERT INTO/,
      'INSERT OR IGNORE INTO',
    );
  }

  mapType(column: ColumnInfo, source: ClusterType): string {
    if (source === this.engine) return column.fullType || '';
    switch (column.kind) {
      case 'integer':
      case 'bigint':
      case 'boolean':
        return 'INTEGER';
      case 'float':
        return 'REAL';
      case 'decimal':
        return 'NUMERIC';
      case 'binary':
        return 'BLOB';
      case 'date':
        return 'DATE';
      case 'datetime':
      case 'datetimetz':
        return 'DATETIME';
      case 'json':
        return 'JSON';
      default:
        return 'TEXT';
    }
  }

  columnDefinition(
    column: ColumnInfo,
    source: ClusterType,
    opts: { inlinePrimaryKey?: boolean } = {},
  ) {
    if (opts.inlinePrimaryKey) {
      return `${this.quote(column.name)} INTEGER PRIMARY KEY AUTOINCREMENT`;
    }
    return super.columnDefinition(
      { ...column, isAutoIncrement: false },
      source,
    );
  }

  alterColumnType() {
    return null; // SQLite cannot change a column's type in place
  }
  addForeignKey() {
    return null; // only possible in CREATE TABLE
  }
  createIndex(
    ref: TableRef,
    index: IndexInfo,
    source: ClusterType,
    targetColumns: ColumnInfo[],
  ) {
    if (index.primary || index.constraint) return null;
    if (source === this.engine && index.definition) {
      return index.definition.replace(
        /^CREATE (UNIQUE )?INDEX /i,
        'CREATE $1INDEX IF NOT EXISTS ',
      );
    }
    const ddl = super.createIndex(ref, index, source, targetColumns);
    return (
      ddl?.replace(
        /^CREATE (UNIQUE )?INDEX /,
        'CREATE $1INDEX IF NOT EXISTS ',
      ) ?? null
    );
  }
  protected canAutoIncrement() {
    return false;
  }
  protected autoIncrementClause() {
    return '';
  }
  stringLiteral(value: string) {
    return `'${value.replaceAll("'", "''")}'`;
  }
  binaryLiteral(hex: string) {
    return `X'${hex}'`;
  }
  booleanLiteral(value: boolean) {
    return value ? '1' : '0';
  }
  protected createTableWrapper(ref: TableRef, body: string) {
    return `CREATE TABLE IF NOT EXISTS ${this.qualify(ref)} ${body}`;
  }
}

const DIALECTS: Record<ClusterType, Dialect> = {
  [ClusterType.MYSQL]: new MySQLDialect(),
  [ClusterType.POSTGRES]: new PostgresDialect(),
  [ClusterType.MSSQL]: new MSSQLDialect(),
  [ClusterType.SQLITE]: new SQLiteDialect(),
};

export function dialectFor(engine: ClusterType): Dialect {
  const d = DIALECTS[engine];
  if (!d) throw new Error(`Unsupported database type: ${String(engine)}`);
  return d;
}

export function tableRef(
  columns: { schema: string | null; table: string }[],
): TableRef {
  return { schema: columns[0]?.schema ?? null, table: columns[0]?.table ?? '' };
}

/**
 * Key for matching a table across two clusters: schema-qualified when both
 * engines have schemas (default schemas treated alike), else the bare name.
 */
export function matchKey(
  dialect: Dialect,
  ref: TableRef,
  schemaAware: boolean,
) {
  if (!schemaAware) return ref.table;
  const schema =
    ref.schema && ref.schema !== dialect.defaultSchema ? ref.schema : '';
  return `${schema}.${ref.table}`;
}

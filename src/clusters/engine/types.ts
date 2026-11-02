import { ClusterType } from '../entities/cluster.entity';

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify';
export const SSL_MODES: SslMode[] = ['disable', 'prefer', 'require', 'verify'];

/** Decrypted connection details for one cluster. */
export interface ConnectionTarget {
  id: string;
  userId: string;
  type: ClusterType;
  host: string;
  port: number;
  username: string;
  password: string | null;
  database: string;
  sslMode: SslMode;
  isLocal: boolean;
  /** Connection saved on the agent; host and credentials are then unused. */
  agentConnection: string | null;
}

/**
 * How a column's values should be read and written. Every engine's native
 * type is mapped onto one of these so value handling is written once.
 */
export type ValueKind =
  | 'json'
  | 'binary'
  | 'boolean'
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'float'
  | 'date'
  | 'datetime'
  | 'datetimetz'
  | 'time'
  | 'uuid'
  | 'array'
  | 'text'
  | 'other';

/** A table: `schema` is null on engines without schemas (MySQL, SQLite). */
export interface TableRef {
  schema: string | null;
  table: string;
}

export interface ColumnInfo extends TableRef {
  /** Name used by the API: `table`, or `schema.table` outside the default schema. */
  tableName: string;
  name: string;
  /** Engine data type, e.g. "varchar", "int4", "datetime2". */
  type: string;
  /** Exact declared type, e.g. "varchar(255)", "numeric(10,2)", "text[]". */
  fullType: string;
  nullable: 'YES' | 'NO';
  defaultValue: string | null;
  columnKey: 'PRI' | '';
  isAutoIncrement: boolean;
  isGenerated: boolean;
  generationExpression: string | null;
  /** MySQL "on update CURRENT_TIMESTAMP" clause, if any. */
  onUpdate: string | null;
  referencedTable: string | null;
  referencedColumn: string | null;
  udtName?: string;
  enumValues?: string | null;
  ordinal: number;
  kind: ValueKind;
}

export type Row = Record<string, unknown>;

export interface IndexInfo extends TableRef {
  tableName: string;
  name: string;
  unique: boolean;
  primary: boolean;
  /** Backed by a UNIQUE constraint rather than a plain index. */
  constraint: boolean;
  columns: string[];
  descending: boolean[];
  /** MySQL key prefix lengths (null = whole column). */
  prefixes: (number | null)[];
  include: string[];
  where: string | null;
  /** FULLTEXT, SPATIAL, CLUSTERED... when not a plain b-tree. */
  method: string | null;
  /** Uses expressions or a predicate this layer can't translate. */
  expression: boolean;
  /** Exact DDL on the source engine, when the engine provides it. */
  definition: string | null;
}

export type ReferentialAction =
  | 'NO ACTION'
  | 'RESTRICT'
  | 'CASCADE'
  | 'SET NULL'
  | 'SET DEFAULT';

export interface ForeignKeyInfo extends TableRef {
  tableName: string;
  name: string;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

export interface Statement {
  sql: string;
  params?: unknown[];
  /** Value kind of each param, so drivers can bind typed NULLs (SQL Server). */
  paramKinds?: (ValueKind | null)[];
}

export interface RunResult {
  rows: Row[];
  rowCount: number;
  insertId?: string | number | null;
}

export interface ScriptResult {
  results: Row[][];
  rowCounts: number[];
}

export interface PageResult {
  rows: Row[];
  total: number;
}

export interface TxHandle {
  run(
    sql: string,
    params?: unknown[],
    paramKinds?: (ValueKind | null)[],
  ): Promise<RunResult>;
  runMany(statements: Statement[]): Promise<RunResult[]>;
}

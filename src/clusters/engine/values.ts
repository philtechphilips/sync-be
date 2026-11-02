import { BadRequestException } from '@nestjs/common';
import { ClusterType } from '../entities/cluster.entity';
import { ColumnInfo, Row, ValueKind } from './types';

/**
 * Maps an engine-specific column type to a ValueKind. `fullType` is used
 * for the cases where the base type is ambiguous (MySQL tinyint(1), bit(1)).
 */
export function classifyColumn(
  engine: ClusterType,
  type: string,
  fullType: string,
  udtName?: string,
): ValueKind {
  const t = (type || '').toLowerCase().trim();
  const full = (fullType || '').toLowerCase().trim();

  switch (engine) {
    case ClusterType.MYSQL:
      if (t === 'json') return 'json';
      if (t === 'tinyint' && full.startsWith('tinyint(1)')) return 'boolean';
      if (t === 'bit') return full === 'bit(1)' ? 'boolean' : 'binary';
      if (/^(tiny|medium|long)?blob$|^(var)?binary$/.test(t)) return 'binary';
      if (/^(tiny|small|medium)?int$|^integer$|^year$/.test(t))
        return 'integer';
      if (t === 'bigint') return 'bigint';
      if (t === 'decimal' || t === 'numeric') return 'decimal';
      if (t === 'float' || t === 'double' || t === 'real') return 'float';
      if (t === 'date') return 'date';
      if (t === 'datetime' || t === 'timestamp') return 'datetime';
      if (t === 'time') return 'time';
      if (
        /^(var)?char$|text$|^enum$|^set$/.test(t) ||
        t === 'tinytext' ||
        t === 'mediumtext' ||
        t === 'longtext'
      )
        return 'text';
      return 'other';

    case ClusterType.POSTGRES: {
      const u = (udtName || t).toLowerCase();
      if (u.startsWith('_') || t === 'array') return 'array';
      if (u === 'json' || u === 'jsonb') return 'json';
      if (u === 'bytea') return 'binary';
      if (u === 'bool') return 'boolean';
      if (u === 'int2' || u === 'int4') return 'integer';
      if (u === 'int8') return 'bigint';
      if (u === 'numeric') return 'decimal';
      if (u === 'float4' || u === 'float8') return 'float';
      if (u === 'date') return 'date';
      if (u === 'timestamp') return 'datetime';
      if (u === 'timestamptz') return 'datetimetz';
      if (u === 'time' || u === 'timetz') return 'time';
      if (u === 'uuid') return 'uuid';
      if (t === 'user-defined') return 'text'; // enums and similar
      return 'text';
    }

    case ClusterType.MSSQL:
      if (t === 'json') return 'json';
      if (t === 'bit') return 'boolean';
      if (t === 'tinyint' || t === 'smallint' || t === 'int') return 'integer';
      if (t === 'bigint') return 'bigint';
      if (/^(decimal|numeric|money|smallmoney)$/.test(t)) return 'decimal';
      if (t === 'float' || t === 'real') return 'float';
      if (t === 'date') return 'date';
      if (/^(datetime|datetime2|smalldatetime)$/.test(t)) return 'datetime';
      if (t === 'datetimeoffset') return 'datetimetz';
      if (t === 'time') return 'time';
      if (t === 'uniqueidentifier') return 'uuid';
      if (/^(binary|varbinary|image|timestamp|rowversion)$/.test(t))
        return 'binary';
      if (/char$|text$|^xml$/.test(t)) return 'text';
      return 'other';

    case ClusterType.SQLITE: {
      // SQLite type affinity rules (https://sqlite.org/datatype3.html)
      const u = t.toUpperCase();
      if (u.includes('JSON')) return 'json';
      if (u.includes('BOOL')) return 'boolean';
      if (u.includes('INT')) return 'integer';
      if (u.includes('CHAR') || u.includes('CLOB') || u.includes('TEXT'))
        return 'text';
      if (u.includes('BLOB') || u === '') return 'binary';
      if (u.includes('REAL') || u.includes('FLOA') || u.includes('DOUB'))
        return 'float';
      if (u.includes('DATETIME') || u.includes('TIMESTAMP')) return 'datetime';
      if (u.includes('DATE')) return 'date';
      if (u.includes('TIME')) return 'time';
      if (u.includes('NUMERIC') || u.includes('DECIMAL')) return 'decimal';
      return 'text';
    }
  }
  return 'other';
}

/** Text form of a driver value (objects as JSON, null as ''). */
export function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value as number | boolean | bigint);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function formatUtcDate(d: Date) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function formatUtcTime(d: Date) {
  const ms = d.getUTCMilliseconds();
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${ms ? `.${pad(ms, 3)}` : ''}`;
}

/**
 * Converts a driver value into something that survives JSON unchanged:
 * Buffers become 0x-prefixed hex, BigInts become numbers or strings, and
 * Dates (only SQL Server still returns them) become wall-clock strings.
 */
export function normalizeValue(value: unknown, sqlType?: string): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return '0x' + Buffer.from(value).toString('hex');
  }
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const t = (sqlType || '').toLowerCase();
    if (t === 'date') return formatUtcDate(value);
    if (t === 'time') return formatUtcTime(value);
    if (t === 'datetimeoffset') return value.toISOString();
    return `${formatUtcDate(value)} ${formatUtcTime(value)}`;
  }
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v));
  return value;
}

export function normalizeRows(
  rows: Row[],
  columnTypes?: Record<string, string | undefined>,
): Row[] {
  return rows.map((row) => {
    const out: Row = {};
    for (const key of Object.keys(row)) {
      out[key] = normalizeValue(row[key], columnTypes?.[key]);
    }
    return out;
  });
}

const NUMERIC_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const HEX_RE = /^(0x|\\x)([0-9a-fA-F]{2})*$/;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
const DATETIME_RE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)(Z|[+-]\d{2}(:?\d{2})?)?$/i;

function invalid(column: ColumnInfo, what: string, value: unknown): never {
  throw new BadRequestException(
    `Invalid ${what} for column "${column.name}": ${toText(value).slice(0, 80)}`,
  );
}

function toBoolean(column: ColumnInfo, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = toText(value).trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y', 'on', '0x01'].includes(s)) return true;
  if (['0', 'false', 'f', 'no', 'n', 'off', '0x00'].includes(s)) return false;
  return invalid(column, 'boolean', value);
}

/**
 * Converts a value from the API (JSON) into what the driver must bind for
 * this column. JSON columns take a JSON *value* (object, array, string,
 * number...), which is serialised here exactly once.
 */
export function coerceValue(
  engine: ClusterType,
  column: ColumnInfo,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return null;

  switch (column.kind) {
    case 'json':
      return JSON.stringify(value);

    case 'binary': {
      if (Buffer.isBuffer(value)) return value;
      if (
        typeof value === 'object' &&
        (value as any).type === 'Buffer' &&
        Array.isArray((value as any).data)
      ) {
        return Buffer.from((value as any).data as number[]);
      }
      if (typeof value === 'string') {
        if (HEX_RE.test(value)) return Buffer.from(value.slice(2), 'hex');
        return Buffer.from(value, 'utf8');
      }
      return invalid(column, 'binary value (use 0x-prefixed hex)', value);
    }

    case 'boolean': {
      const b = toBoolean(column, value);
      return engine === ClusterType.POSTGRES ? b : b ? 1 : 0;
    }

    case 'integer':
    case 'bigint':
    case 'decimal':
    case 'float': {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return invalid(column, 'number', value);
        return value;
      }
      if (typeof value === 'boolean') return value ? 1 : 0;
      const s = toText(value).trim();
      if (s === '') return null;
      if (!NUMERIC_RE.test(s)) return invalid(column, 'number', value);
      // Keep as a string so BIGINT / DECIMAL never pass through a JS double.
      return s;
    }

    case 'date': {
      const s = toText(value).trim();
      if (s === '') return null;
      const m = DATE_RE.exec(s);
      if (!m) return invalid(column, 'date (expected YYYY-MM-DD)', value);
      return m[1];
    }

    case 'datetime': {
      const s = toText(value).trim();
      if (s === '') return null;
      const m = DATETIME_RE.exec(s);
      if (!m) {
        if (DATE_RE.test(s) && s.length === 10) return `${s} 00:00:00`;
        return invalid(
          column,
          'date-time (expected YYYY-MM-DD HH:MM:SS)',
          value,
        );
      }
      // A naive column stores wall-clock time, so drop any zone suffix
      // instead of letting the driver or server shift it.
      const time = m[2].length === 5 ? `${m[2]}:00` : m[2];
      return engine === ClusterType.MSSQL
        ? `${m[1]}T${time}` // ISO form is language-independent in SQL Server
        : `${m[1]} ${time}`;
    }

    case 'datetimetz':
    case 'time':
    case 'uuid': {
      const s = toText(value).trim();
      return s === '' ? null : s;
    }

    case 'array': {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        const s = value.trim();
        if (s.startsWith('[')) {
          try {
            const parsed: unknown = JSON.parse(s);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            /* fall through */
          }
          return invalid(column, 'array (expected a JSON array)', value);
        }
        if (s.startsWith('{')) return s; // Postgres array literal
      }
      return invalid(column, 'array', value);
    }

    case 'text':
      if (typeof value === 'string') return value;
      if (typeof value === 'object') return JSON.stringify(value);
      return toText(value);

    default:
      if (typeof value === 'object')
        return invalid(
          column,
          `value (${column.type} is read-only here)`,
          value,
        );
      return engine === ClusterType.SQLITE && typeof value === 'boolean'
        ? Number(value)
        : value;
  }
}

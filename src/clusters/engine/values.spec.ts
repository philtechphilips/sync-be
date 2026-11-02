import { ClusterType } from '../entities/cluster.entity';
import { classifyColumn, coerceValue, normalizeValue } from './values';
import { ColumnInfo, ValueKind } from './types';

const col = (kind: ValueKind, name = 'c'): ColumnInfo => ({
  schema: null,
  table: 't',
  tableName: 't',
  name,
  type: kind,
  fullType: kind,
  nullable: 'YES',
  defaultValue: null,
  columnKey: '',
  isAutoIncrement: false,
  isGenerated: false,
  generationExpression: null,
  onUpdate: null,
  referencedTable: null,
  referencedColumn: null,
  ordinal: 1,
  kind,
});

describe('value handling', () => {
  it('classifies engine types', () => {
    expect(classifyColumn(ClusterType.MYSQL, 'tinyint', 'tinyint(1)')).toBe(
      'boolean',
    );
    expect(
      classifyColumn(ClusterType.MYSQL, 'tinyint', 'tinyint unsigned'),
    ).toBe('integer');
    expect(classifyColumn(ClusterType.MYSQL, 'json', 'json')).toBe('json');
    expect(classifyColumn(ClusterType.MYSQL, 'binary', 'binary(16)')).toBe(
      'binary',
    );
    expect(
      classifyColumn(ClusterType.POSTGRES, 'ARRAY', 'text[]', '_text'),
    ).toBe('array');
    expect(
      classifyColumn(ClusterType.POSTGRES, 'jsonb', 'jsonb', 'jsonb'),
    ).toBe('json');
    expect(classifyColumn(ClusterType.MSSQL, 'money', 'money')).toBe('decimal');
    expect(
      classifyColumn(ClusterType.SQLITE, 'varchar(10)', 'VARCHAR(10)'),
    ).toBe('text');
  });

  it('serialises JSON values exactly once', () => {
    expect(coerceValue(ClusterType.MYSQL, col('json'), { a: 1 })).toBe(
      '{"a":1}',
    );
    expect(coerceValue(ClusterType.POSTGRES, col('json'), [1, 2])).toBe(
      '[1,2]',
    );
    expect(coerceValue(ClusterType.POSTGRES, col('json'), 'hello')).toBe(
      '"hello"',
    );
  });

  it('turns hex strings and legacy Buffer JSON into Buffers', () => {
    expect(coerceValue(ClusterType.MYSQL, col('binary'), '0xdead')).toEqual(
      Buffer.from([0xde, 0xad]),
    );
    expect(
      coerceValue(ClusterType.POSTGRES, col('binary'), {
        type: 'Buffer',
        data: [1, 2],
      }),
    ).toEqual(Buffer.from([1, 2]));
  });

  it('keeps date-times as wall-clock strings', () => {
    expect(
      coerceValue(
        ClusterType.MYSQL,
        col('datetime'),
        '2026-11-02T08:30:00.000Z',
      ),
    ).toBe('2026-11-02 08:30:00.000');
    expect(
      coerceValue(ClusterType.MSSQL, col('datetime'), '2026-11-02 08:30'),
    ).toBe('2026-11-02T08:30:00');
    expect(
      coerceValue(
        ClusterType.POSTGRES,
        col('date'),
        '2026-11-01T23:00:00.000Z',
      ),
    ).toBe('2026-11-01');
    expect(() =>
      coerceValue(ClusterType.MYSQL, col('date'), 'tomorrow'),
    ).toThrow();
  });

  it('keeps big numbers as exact strings and maps booleans per engine', () => {
    expect(
      coerceValue(ClusterType.MYSQL, col('bigint'), '9007199254740993'),
    ).toBe('9007199254740993');
    expect(coerceValue(ClusterType.MYSQL, col('integer'), '')).toBeNull();
    expect(() =>
      coerceValue(ClusterType.MYSQL, col('integer'), 'null'),
    ).toThrow();
    expect(coerceValue(ClusterType.MYSQL, col('boolean'), 'false')).toBe(0);
    expect(coerceValue(ClusterType.POSTGRES, col('boolean'), '0x01')).toBe(
      true,
    );
  });

  it('normalizes driver values for JSON transport', () => {
    expect(normalizeValue(Buffer.from([0xab]))).toBe('0xab');
    expect(normalizeValue(BigInt('9007199254740993'))).toBe('9007199254740993');
    expect(normalizeValue(BigInt(5))).toBe(5);
    expect(
      normalizeValue(new Date('2026-11-02T08:30:00.000Z'), 'datetime2'),
    ).toBe('2026-11-02 08:30:00');
    expect(normalizeValue(new Date('2026-11-02T00:00:00.000Z'), 'date')).toBe(
      '2026-11-02',
    );
  });
});

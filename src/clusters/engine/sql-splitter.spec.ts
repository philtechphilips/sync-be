import { ClusterType } from '../entities/cluster.entity';
import {
  findDestructiveStatements,
  isSingleRowQuery,
  splitEachStatement,
  splitStatements,
} from './sql-splitter';

const texts = (sql: string, engine: ClusterType) =>
  splitEachStatement(sql, engine).map((s) => s.text);

describe('sql splitter', () => {
  it('keeps semicolons inside strings, identifiers and comments', () => {
    const sql = `INSERT INTO t VALUES ('a;b', "c;d"); -- x; y
      SELECT \`we;ird\` FROM t /* ; */;`;
    expect(texts(sql, ClusterType.MYSQL)).toEqual([
      `INSERT INTO t VALUES ('a;b', "c;d")`,
      expect.stringMatching(/^-- x; y\s+SELECT `we;ird` FROM t \/\* ; \*\/$/),
    ]);
  });

  it('handles MySQL backslash escapes and doubled quotes', () => {
    const sql = `INSERT INTO t VALUES ('it\\'s; fine', 'a''b;c'); SELECT 1`;
    expect(texts(sql, ClusterType.MYSQL)).toHaveLength(2);
  });

  it('does not treat backslash as an escape in standard Postgres strings', () => {
    const sql = `SELECT 'C:\\'; SELECT 2`;
    expect(texts(sql, ClusterType.POSTGRES)).toEqual([
      `SELECT 'C:\\'`,
      'SELECT 2',
    ]);
  });

  it('keeps Postgres dollar-quoted bodies together', () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql; SELECT 1;`;
    expect(texts(sql, ClusterType.POSTGRES)).toHaveLength(2);
  });

  it('keeps trigger bodies together and honours DELIMITER', () => {
    const sqlite = `CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE x SET n = n + 1; INSERT INTO y VALUES (CASE WHEN 1 THEN 2 END); END; SELECT 1;`;
    expect(texts(sqlite, ClusterType.SQLITE)).toHaveLength(2);
    const mysql = `DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 3;`;
    expect(texts(mysql, ClusterType.MYSQL)).toEqual([
      'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END',
      'SELECT 3',
    ]);
  });

  it('splits SQL Server scripts on GO only, unless asked to split statements', () => {
    const sql = `SELECT 1; SELECT 2\nGO\nSELECT [a;b] FROM t`;
    expect(splitStatements(sql, ClusterType.MSSQL)).toEqual([
      'SELECT 1; SELECT 2',
      'SELECT [a;b] FROM t',
    ]);
    expect(texts(sql, ClusterType.MSSQL)).toEqual([
      'SELECT 1',
      'SELECT 2',
      'SELECT [a;b] FROM t',
    ]);
  });

  it('detects destructive statements without false positives', () => {
    expect(
      findDestructiveStatements(
        `SELECT * FROM updates WHERE note = 'drop table x'`,
        ClusterType.MYSQL,
      ),
    ).toEqual([]);
    expect(
      findDestructiveStatements(`-- drop table\nselect 1`, ClusterType.MYSQL),
    ).toEqual([]);
    expect(
      findDestructiveStatements(`drop\ntable users`, ClusterType.MYSQL),
    ).toEqual(['DROP TABLE']);
    expect(
      findDestructiveStatements(`/* hi */ TRUNCATE t`, ClusterType.POSTGRES),
    ).toEqual(['TRUNCATE T']);
    expect(
      findDestructiveStatements(
        `ALTER TABLE t DROP COLUMN c`,
        ClusterType.POSTGRES,
      ),
    ).toEqual(['ALTER ... DROP']);
  });

  it('recognises single pageable queries', () => {
    expect(
      isSingleRowQuery(
        'WITH a AS (SELECT 1) SELECT * FROM a;',
        ClusterType.POSTGRES,
      ),
    ).toBe(true);
    expect(isSingleRowQuery(`SELECT ';' AS x`, ClusterType.MYSQL)).toBe(true);
    expect(isSingleRowQuery('SELECT 1; SELECT 2', ClusterType.MYSQL)).toBe(
      false,
    );
    expect(isSingleRowQuery('UPDATE t SET a = 1', ClusterType.MYSQL)).toBe(
      false,
    );
  });
});

import { ClusterType } from '../entities/cluster.entity';

interface Scanned {
  text: string;
  /** Upper-cased words outside strings, identifiers and comments. */
  words: string[];
}

const COMPOUND_KINDS = ['TRIGGER', 'PROCEDURE', 'FUNCTION', 'EVENT'];
const MAX_WORDS = 200;

/**
 * Splits a SQL script into statements, respecting quoted strings,
 * identifiers, comments, Postgres dollar-quoting, MySQL DELIMITER
 * directives, BEGIN...END bodies of triggers/procedures, and SQL Server GO
 * batch separators.
 */
export function scanStatements(
  sql: string,
  engine: ClusterType,
  mssqlSplitOnSemicolon = false,
): Scanned[] {
  const out: Scanned[] = [];
  const isMySQL = engine === ClusterType.MYSQL;
  const isPg = engine === ClusterType.POSTGRES;
  const isMssql = engine === ClusterType.MSSQL;

  let delimiter = ';';
  let start = 0;
  let words: string[] = [];
  let depth = 0;
  let i = 0;
  const n = sql.length;

  const push = (end: number, next: number) => {
    const text = sql.slice(start, end).trim();
    if (text) out.push({ text, words });
    start = next;
    words = [];
    depth = 0;
  };

  const atLineStart = (pos: number) => {
    let j = pos - 1;
    while (j >= 0 && (sql[j] === ' ' || sql[j] === '\t')) j--;
    return j < 0 || sql[j] === '\n' || sql[j] === '\r';
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // MySQL client DELIMITER directive (used by mysqldump output)
    if (isMySQL && (c === 'D' || c === 'd') && atLineStart(i)) {
      const m = /^DELIMITER[ \t]+(\S+)[^\n]*/i.exec(sql.slice(i));
      if (m) {
        push(i, i + m[0].length);
        delimiter = m[1];
        i += m[0].length;
        continue;
      }
    }

    // SQL Server batch separator: a line containing only GO
    if (isMssql && (c === 'G' || c === 'g') && atLineStart(i)) {
      const m = /^GO[ \t]*(\r?\n|$)/i.exec(sql.slice(i));
      if (m) {
        push(i, i + m[0].length);
        i += m[0].length;
        continue;
      }
    }

    // Comments
    if ((c === '-' && next === '-') || (isMySQL && c === '#')) {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    // Quoted strings and identifiers
    if (c === "'" || c === '"' || c === '`' || (isMssql && c === '[')) {
      const close = c === '[' ? ']' : c;
      const backslashEscapes =
        (isMySQL && c !== '`') ||
        (isPg &&
          c === "'" &&
          /[eE]/.test(sql[i - 1] ?? '') &&
          !/\w/.test(sql[i - 2] ?? ''));
      i++;
      while (i < n) {
        if (backslashEscapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }

    // Postgres dollar-quoted bodies: $tag$ ... $tag$
    if (isPg && c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        continue;
      }
    }

    // Words (for keyword detection and BEGIN/END tracking)
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (
        j < n &&
        /[A-Za-z0-9_$]/.test(sql[j]) &&
        !(delimiter !== ';' && sql.startsWith(delimiter, j))
      )
        j++;
      const word = sql.slice(i, j).toUpperCase();
      if (words.length < MAX_WORDS) words.push(word);
      // Trigger/procedure bodies contain ';' — track BEGIN...END depth.
      const compound =
        !isPg &&
        !isMssql &&
        words[0] === 'CREATE' &&
        words.slice(1, 5).some((w) => COMPOUND_KINDS.includes(w));
      if (compound) {
        if (word === 'BEGIN' || word === 'CASE') depth++;
        else if (word === 'END') {
          const after = /^\s*([A-Za-z]+)/.exec(sql.slice(j));
          const follow = after?.[1].toUpperCase();
          if (!follow || !['IF', 'LOOP', 'WHILE', 'REPEAT'].includes(follow))
            depth = Math.max(0, depth - 1);
        }
      }
      i = j;
      continue;
    }

    // Statement delimiter
    // A custom DELIMITER exists precisely so bodies can contain ';'.
    if (sql.startsWith(delimiter, i) && (depth === 0 || delimiter !== ';')) {
      // SQL Server scripts run as whole batches; only GO splits them.
      if (isMssql && delimiter === ';' && !mssqlSplitOnSemicolon) {
        i += 1;
        continue;
      }
      push(i, i + delimiter.length);
      i += delimiter.length;
      continue;
    }

    i++;
  }
  push(n, n);
  return out;
}

export function splitStatements(sql: string, engine: ClusterType): string[] {
  return scanStatements(sql, engine).map((s) => s.text);
}

/**
 * Like splitStatements, but SQL Server scripts are split on ';' as well.
 * Used where each statement must run on its own (restores, safety checks).
 */
export function splitEachStatement(
  sql: string,
  engine: ClusterType,
): Scanned[] {
  return scanStatements(sql, engine, true);
}

const ROW_RETURNING = new Set([
  'SELECT',
  'WITH',
  'SHOW',
  'VALUES',
  'TABLE',
  'EXPLAIN',
  'DESCRIBE',
  'DESC',
  'PRAGMA',
]);

/** True if the script is one statement that returns rows (pageable). */
export function isSingleRowQuery(sql: string, engine: ClusterType): boolean {
  const statements = splitEachStatement(sql, engine);
  return (
    statements.length === 1 && ROW_RETURNING.has(statements[0].words[0] ?? '')
  );
}

/**
 * Returns a description of each destructive statement (DROP, TRUNCATE,
 * ALTER ... DROP) in the script. Keywords inside strings and comments are
 * ignored, so `SELECT 'drop table'` is not flagged.
 */
export function findDestructiveStatements(
  sql: string,
  engine: ClusterType,
): string[] {
  const found: string[] = [];
  for (const s of splitEachStatement(sql, engine)) {
    const [first, second] = s.words;
    if (first === 'DROP' || first === 'TRUNCATE') {
      found.push([first, second].filter(Boolean).join(' '));
    } else if (first === 'ALTER' && s.words.includes('DROP')) {
      found.push('ALTER ... DROP');
    }
  }
  return found;
}

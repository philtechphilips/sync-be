import { Row } from './types';
import { toText } from './values';

/**
 * CSV with one convention on top of RFC 4180 so NULL survives a round trip:
 * an empty unquoted field is NULL, `""` is an empty string.
 */
function formatField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = toText(value);
  if (str === '' || /[",\r\n]/.test(str) || str !== str.trim()) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

export function formatCsv(rows: Row[], columns?: string[]): string {
  const headers = columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
  if (headers.length === 0) return '';
  const lines = [headers.map(formatField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => formatField(row[h])).join(','));
  }
  return lines.join('\r\n');
}

/** Parses CSV text into rows keyed by the header line. */
export function parseCsv(text: string): { headers: string[]; rows: Row[] } {
  const records: (string | null)[][] = [];
  let record: (string | null)[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => {
    record.push(!wasQuoted && field === '' ? null : field);
    field = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    if (!(record.length === 1 && record[0] === null)) records.push(record);
    record = [];
  };

  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      wasQuoted = true;
      i++;
    } else if (c === ',') {
      endField();
      i++;
    } else if (c === '\r' || c === '\n') {
      endRecord();
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || wasQuoted || record.length > 0) endRecord();

  const [headerRecord, ...dataRecords] = records;
  const headers = (headerRecord ?? []).map((h) => h ?? '');
  const rows = dataRecords.map((values) => {
    const row: Row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] ?? null;
    });
    return row;
  });
  return { headers, rows };
}

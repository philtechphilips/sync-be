import { formatCsv, parseCsv } from './csv';

describe('csv', () => {
  it('round-trips nulls, empty strings, quotes, commas, newlines and JSON', () => {
    const rows = [
      {
        id: 1,
        a: null,
        b: '',
        c: 'he said "hi", then\nleft',
        d: { x: [1, 2] },
      },
      { id: 2, a: ' padded ', b: 'plain', c: 'x', d: null },
    ];
    const parsed = parseCsv(formatCsv(rows));
    expect(parsed.headers).toEqual(['id', 'a', 'b', 'c', 'd']);
    expect(parsed.rows).toEqual([
      {
        id: '1',
        a: null,
        b: '',
        c: 'he said "hi", then\nleft',
        d: '{"x":[1,2]}',
      },
      { id: '2', a: ' padded ', b: 'plain', c: 'x', d: null },
    ]);
  });

  it('accepts LF line endings and a BOM', () => {
    expect(parseCsv('\ufeffa,b\n1,2\n').rows).toEqual([{ a: '1', b: '2' }]);
  });
});

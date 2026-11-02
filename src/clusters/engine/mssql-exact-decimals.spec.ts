import { scaledDecimal } from './mssql-exact-decimals';

describe('SQL Server exact decimals', () => {
  it('formats scaled integers without losing digits', () => {
    expect(scaledDecimal(false, 12345678901234123456n, 6)).toBe(
      '12345678901234.123456',
    );
    expect(scaledDecimal(true, 5n, 4)).toBe('-0.0005');
    expect(scaledDecimal(false, 0n, 2)).toBe('0.00');
    expect(scaledDecimal(true, 0n, 0)).toBe('0');
    expect(
      scaledDecimal(false, 99999999999999999999999999999999999999n, 0),
    ).toBe('99999999999999999999999999999999999999');
  });
});

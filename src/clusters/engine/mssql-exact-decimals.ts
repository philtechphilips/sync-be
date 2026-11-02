/**
 * tedious (the SQL Server driver) turns DECIMAL/NUMERIC and MONEY values
 * into JS doubles, which silently loses digits beyond ~15-16. This wraps its
 * value reader so those types come back as exact decimal strings instead,
 * everywhere: table views, the query editor, backups and sync.
 */
import { dirname } from 'node:path';

interface ValueParser {
  readValue: (...args: any[]) => any;
  __synqExactDecimals?: boolean;
}
interface Helpers {
  Result: new (value: unknown, offset: number) => unknown;
  NotEnoughDataError: new (byteCount: number) => Error;
}

/** The tedious copies in use: the one mssql loads (often nested) and the top-level one. */
function tediousCopies(): { parser: ValueParser; helpers: Helpers }[] {
  const roots = new Set<string>();
  for (const from of [
    () => dirname(require.resolve('mssql')),
    () => __dirname,
  ]) {
    try {
      roots.add(
        dirname(require.resolve('tedious/package.json', { paths: [from()] })),
      );
    } catch {
      // not installed from here
    }
  }
  /* eslint-disable @typescript-eslint/no-require-imports */
  return [...roots].map((root) => ({
    parser: require(`${root}/lib/value-parser`) as ValueParser,
    helpers: require(`${root}/lib/token/helpers`) as Helpers,
  }));
  /* eslint-enable @typescript-eslint/no-require-imports */
}

/** Formats an unsigned integer `magnitude` scaled down by 10^scale. */
export function scaledDecimal(
  negative: boolean,
  magnitude: bigint,
  scale: number,
): string {
  let digits = magnitude.toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0');
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return negative && magnitude !== 0n ? `-${digits}` : digits;
}

function patch({ parser, helpers }: { parser: ValueParser; helpers: Helpers }) {
  if (parser.__synqExactDecimals) return;

  const need = (buf: Buffer, end: number) => {
    if (buf.length < end) throw new helpers.NotEnoughDataError(end);
  };

  /** DECIMAL/NUMERIC: length byte, sign byte (1 = positive), little-endian magnitude. */
  const readNumeric = (buf: Buffer, offset: number, scale: number) => {
    need(buf, offset + 1);
    const length = buf.readUInt8(offset);
    if (length === 0) return new helpers.Result(null, offset + 1);
    need(buf, offset + 1 + length);
    const negative = buf.readUInt8(offset + 1) !== 1;
    let magnitude = 0n;
    for (let i = length - 1; i >= 1; i--) {
      magnitude = (magnitude << 8n) | BigInt(buf[offset + 1 + i]);
    }
    return new helpers.Result(
      scaledDecimal(negative, magnitude, scale),
      offset + 1 + length,
    );
  };

  /** MONEY is a signed 64-bit integer of 1/10000 units, high 32 bits first. */
  const readMoney = (buf: Buffer, offset: number, bytes: 4 | 8) => {
    need(buf, offset + bytes);
    const value =
      bytes === 4
        ? BigInt(buf.readInt32LE(offset))
        : (BigInt(buf.readInt32LE(offset)) << 32n) |
          BigInt(buf.readUInt32LE(offset + 4));
    const negative = value < 0n;
    return new helpers.Result(
      scaledDecimal(negative, negative ? -value : value, 4),
      offset + bytes,
    );
  };

  const original = parser.readValue;
  parser.readValue = function readValue(
    buf: Buffer,
    offset: number,
    metadata: { type?: { name?: string }; scale?: number },
    ...rest: unknown[]
  ) {
    switch (metadata?.type?.name) {
      case 'NumericN':
      case 'DecimalN':
        return readNumeric(buf, offset, metadata.scale ?? 0);
      case 'Money':
        return readMoney(buf, offset, 8);
      case 'SmallMoney':
        return readMoney(buf, offset, 4);
      case 'MoneyN': {
        need(buf, offset + 1);
        const length = buf.readUInt8(offset);
        if (length === 0) return new helpers.Result(null, offset + 1);
        return readMoney(buf, offset + 1, length === 4 ? 4 : 8);
      }
      default:
        return original.call(this, buf, offset, metadata, ...rest);
    }
  };
  parser.__synqExactDecimals = true;
}

tediousCopies().forEach(patch);

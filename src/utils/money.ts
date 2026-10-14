/** Safe integer cents. Public Phase 1 contracts retain dollar numbers at their boundaries. */
export type Cents = number & { readonly __cents: unique symbol };
export const DEFAULT_TOLERANCE_CENTS = 1 as Cents;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function safeCents(value: bigint): Cents {
  if (value > MAX || value < -MAX) throw new RangeError('Amount exceeds safe cent precision.');
  return Number(value) as Cents;
}

/** Decimal round-half-away-from-zero, implemented from decimal digits with BigInt. */
export function toCents(value: number | string): Cents {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Amount must be finite.');
  let text = String(value).trim();
  if (text === '-') return 0 as Cents; // Explicit accounting zero; a blank is never zero.
  const parentheses = /^\(.*\)$/.test(text);
  if (parentheses) text = text.slice(1, -1).trim();
  text = text.replace(/^([+-]?)\$\s*/, '$1');
  if (text.includes(',')) {
    if (!/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) throw new TypeError('Invalid monetary grouping.');
    text = text.replaceAll(',', '');
  }
  const match = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || (parentheses && match[1])) throw new TypeError('Invalid monetary value.');
  const exponent = Number(match[3] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100 || text.length > 160) throw new RangeError('Unsupported monetary precision.');
  const [whole, fraction = ''] = match[2].split('.');
  const digits = BigInt(`${whole || '0'}${fraction}`);
  const scale = fraction.length - exponent - 2;
  let rounded: bigint;
  if (scale <= 0) rounded = digits * 10n ** BigInt(-scale);
  else {
    const divisor = 10n ** BigInt(scale);
    rounded = digits / divisor + (digits % divisor * 2n >= divisor ? 1n : 0n);
  }
  return safeCents((match[1] === '-' || parentheses) ? -rounded : rounded);
}

export function fromCents(value: Cents): number {
  const dollars = value / 100;
  // Retained dollar-number contracts must not silently lose a cent at extreme magnitudes.
  if (toCents(dollars) !== value) throw new RangeError('Amount cannot retain cent precision in the dollar-number contract.');
  return dollars;
}
export function addCents(values: readonly Cents[]): Cents {
  return safeCents(values.reduce((sum, value) => sum + BigInt(value), 0n));
}
export function subtractCents(left: Cents, right: Cents): Cents { return safeCents(BigInt(left) - BigInt(right)); }
export function sumMoney(values: readonly number[]): number { return fromCents(addCents(values.map(toCents))); }
export function moneyDifference(left: number, right: number): number { return fromCents(subtractCents(toCents(left), toCents(right))); }
export function balancesAgree(left: number, right: number, tolerance: Cents = DEFAULT_TOLERANCE_CENTS): boolean {
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) throw new TypeError('Tolerance must be nonnegative integer cents.');
  return Math.abs(subtractCents(toCents(left), toCents(right))) <= tolerance;
}

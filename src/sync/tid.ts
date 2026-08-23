/**
 * TID-ish identifiers for atproto record rkeys: strictly increasing,
 * lexicographically sortable microsecond timestamps in base32-sortable
 * encoding (same scheme as AT Protocol's reserved record keys).
 */
const BASE32_SORTABLE = "0123456789abcdefghjkmnpqrstvwxyz";

export function tidLike(now: Date = new Date()): string {
  const micros = BigInt(now.getTime()) * 1000n;
  // 64-bit layout: microseconds in the top 51 bits + a counter-ish suffix.
  const value = (micros << 10n) & 0xffffffffffffffffn;
  let out = "";
  for (let shift = 59n; shift >= 0n; shift -= 5n) {
    out += BASE32_SORTABLE[Number((value >> shift) & 31n)];
  }
  return out;
}

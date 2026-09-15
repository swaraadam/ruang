/**
 * Canonical encoding and a real digest — the two primitives an authorization binding rests on.
 *
 * `changeSetHash` used to be two FNV rounds over 64 bits, with a note saying to revisit "if a
 * change-set hash ever gates an apply decision". P0-20 is that day: §12.3 binds a per-action
 * verification to a fingerprint over these digests, and a 64-bit non-cryptographic hash is a
 * decoration on that binding rather than a binding. SHA-256 is written out here rather than
 * imported because this package is loaded by the browser bundle (no `node:crypto`) and CLAUDE.md
 * §8 forbids a new runtime dependency without an ADR line. It is a public, keyless, fixed function
 * pinned to NIST known-answer vectors in `change.test.ts` — not a home-made construction.
 *
 * `encode` is the other half, and the more important one. It covers **every** field of whatever it
 * is handed, so a field added to a plan later is inside the digest by default, and it **throws**
 * rather than skipping anything it cannot represent. The failure shape this exists to avoid is an
 * enumerated list of covered fields, which is silently wrong the moment someone adds a field.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** FIPS 180-4 SHA-256 over the UTF-8 encoding of `text`, lower-case hex. */
export const sha256Hex = (text: string): string => {
  const data = new TextEncoder().encode(text);
  const padded = new Uint8Array((Math.floor((data.length + 8) / 64) + 1) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d] = [h[0]!, h[1]!, h[2]!, h[3]!];
    let [e, f, g, s] = [h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i += 1) {
      const t1 =
        (s + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      s = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    for (const [i, v] of [a, b, c, d, e, f, g, s].entries()) h[i] = (h[i]! + v) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
};

/** A value or an exclusion the encoder cannot honour. Always thrown, never swallowed. */
export class DigestRefusal extends Error {
  constructor(path: string, detail: string) {
    super(`cannot digest ${path === '' ? 'the value' : `'${path}'`}: ${detail}`);
    this.name = 'DigestRefusal';
  }
}

const plain = (v: unknown): v is Readonly<Record<string, unknown>> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/**
 * Keys sorted at every depth; array order preserved, because order is content. Object paths are
 * `a.b`; every element of an array shares the path `a[]`, so one exclusion covers a whole list.
 */
const encode = (
  value: unknown,
  path: string,
  drop: ReadonlySet<string>,
  met: Set<string>,
): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new DigestRefusal(path, `${String(value)} has no canonical form`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item, `${path}[]`, drop, met)).join(',')}]`;
  }
  if (plain(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const child = path === '' ? key : `${path}.${key}`;
      if (drop.has(child)) {
        met.add(child);
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${encode(value[key], child, drop, met)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new DigestRefusal(path, `${Object.prototype.toString.call(value)} has no canonical form`);
};

export const canonicalJson = (value: unknown): string => encode(value, '', new Set(), new Set());

/**
 * `scheme` is a domain separator: two different kinds of thing with the same fields must never
 * share a digest. Every path in `outside` must actually occur — an exclusion that matches nothing
 * is either excluding nothing or naming a field that moved, and both are silent coverage holes.
 */
export const digestExcluding = (
  scheme: string,
  value: unknown,
  outside: readonly string[],
): string => {
  const met = new Set<string>();
  const body = encode(value, '', new Set(outside), met);
  const stale = outside.filter((p) => !met.has(p));
  if (stale.length > 0) {
    throw new DigestRefusal(stale.join(', '), 'declared outside the digest but not present');
  }
  return sha256Hex(`${scheme}\n${body}`);
};

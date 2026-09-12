/**
 * Structural validators for the wire boundary.
 *
 * Hand-rolled on purpose. CLAUDE.md §8 forbids a new runtime dependency without an ADR line, and
 * the §5 stack list ships no schema library, so the gateway gets its boundary validation from
 * these primitives rather than from a new dependency. `shape()` also records its field names,
 * which is what lets the vocabulary fingerprint (see events.ts) notice a payload change and not
 * just a new event type — a general-purpose schema library would not give that for free.
 */

/** A validator narrows `unknown`. `fields` is present only on object shapes. */
export type Check<T> = ((value: unknown) => value is T) & { readonly fields?: readonly string[] };

type AnyCheck = (value: unknown) => boolean;
type Fields = Readonly<Record<string, AnyCheck>>;
type Of<C> = C extends Check<infer T> ? T : never;
export type Infer<F extends Fields> = { readonly [K in keyof F]: Of<F[K]> };

export const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const str: Check<string> = (v): v is string => typeof v === 'string';
export const int: Check<number> = (v): v is number => Number.isSafeInteger(v);
export const num: Check<number> = (v): v is number => typeof v === 'number' && Number.isFinite(v);
export const bool: Check<boolean> = (v): v is boolean => typeof v === 'boolean';

export const nullable =
  <T>(c: Check<T>): Check<T | null> =>
  (v): v is T | null =>
    v === null || c(v);

export const list =
  <T>(c: Check<T>): Check<readonly T[]> =>
  (v): v is readonly T[] =>
    Array.isArray(v) && v.every((x) => c(x));

export const oneOf =
  <const T extends string>(...allowed: readonly T[]): Check<T> =>
  (v): v is T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v);

export const shape = <const F extends Fields>(fields: F): Check<Infer<F>> =>
  Object.assign(
    (v: unknown): v is Infer<F> => isRecord(v) && Object.entries(fields).every(([k, c]) => c(v[k])),
    { fields: Object.keys(fields) },
  );

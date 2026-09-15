/**
 * Seam A, code domain: the full §5.2 contract over a text source of record.
 *
 * This file and `surface.ts` are the whole of what crosses the seam, and both are written in core
 * vocabulary only (invariant 9). The substrate is named honestly *inside* the package, where it is
 * accurate, and `test/seam.test.ts` holds the line in both directions: the exported surface stays
 * neutral, and so does every value and refusal message this adapter actually produces at runtime.
 */
export { createCodeAdapter } from './adapter.js';
export { AdapterRefusal } from './surface.js';
export type { CheckDeclaration, CodeAdapterOptions, RefusalCode } from './surface.js';

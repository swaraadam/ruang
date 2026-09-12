/**
 * Ephemeral session channels — blueprint Appendix A.2. Memory/transport only.
 *
 * This module imports nothing. There is deliberately no base type, no envelope and no validator
 * shared with ./events.ts, so a persistence signature typed on `DurableEvent` cannot be handed
 * one of these (invariant 2). It is not reachable through the package root either: import it as
 * `@internal/protocol/ephemeral`, which makes "I am about to touch non-durable data" explicit.
 *
 * If you find yourself wanting to store one of these, the answer is a durable event with a
 * summarising payload, or a hash-referenced short-retention artifact under state/debug/.
 */

type Frame<C extends string, B> = {
  /**
   * Structural firewall. A durable envelope is discriminated on `type`; forbidding the key here
   * means no ephemeral frame can ever widen into one, even accidentally and even if a future
   * frame grows a `seq`. `channel` is the discriminant on this side.
   */
  readonly type?: never;
  readonly channel: C;
  readonly session_id: string;
  /** Monotonic client clock in milliseconds. Never a `seq`: these are lossy and unordered. */
  readonly at_ms: number;
  readonly body: B;
};

export type AgentMessageDelta = Frame<'agent.message.delta', { readonly text: string }>;
export type ProcessOutput = Frame<
  'process.output',
  { readonly stream: 'stdout' | 'stderr'; readonly text: string }
>;
export type PtyBinary = Frame<'pty.binary', { readonly bytes: Uint8Array }>;
export type ProgressTick = Frame<
  'progress.tick',
  { readonly label: string; readonly fraction: number | null }
>;
/** Cursor / terminal paint state (A.2). Repainted from the live session, never replayed. */
export type PaintState = Frame<
  'paint.state',
  { readonly cols: number; readonly rows: number; readonly cursor: readonly [number, number] }
>;
/** High-frequency tool progress (A.2). */
export type ToolProgress = Frame<
  'tool.progress',
  { readonly tool_id: string; readonly step: string; readonly done: boolean }
>;

export type EphemeralMessage =
  AgentMessageDelta | ProcessOutput | PtyBinary | ProgressTick | PaintState | ToolProgress;

export type EphemeralChannel = EphemeralMessage['channel'];

export const EPHEMERAL_CHANNELS = [
  'agent.message.delta',
  'process.output',
  'pty.binary',
  'progress.tick',
  'paint.state',
  'tool.progress',
] as const satisfies readonly EphemeralChannel[];

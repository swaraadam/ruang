/**
 * Seam B — the host contract, blueprint §6.1: the six facets, in that order, and the shapes they
 * pass. Everything the core is allowed to know about the machine it runs on.
 *
 * ## Why this file is here and not in `packages/` or in `darwin/`
 *
 * The gateway imports `HostAdapter` and must not thereby import Darwin, which rules out living
 * next to the implementation. None of the five packages is an honest home either — `domain` is
 * Seam A ("adapter-free vocabulary only"), `protocol` is the wire contract, `policy` is Seam C and
 * a *consumer* of `capabilities()` — and `packages/*` is enumerated in CLAUDE.md §6, so adding one
 * edits a written layout. So the contract sits one level above its implementations, depending on
 * nothing. Two consequences, both load-bearing: the double is importable on any platform, and
 * `scripts/audit-seams.sh` (which excludes only `adapters/host/darwin/`) scans this package for
 * invariant-10 vocabulary exactly like a core package. The seam is proven by the same grep that
 * guards the spine, in the file the spine actually imports.
 */

/** Blueprint §6.3. Reported, never assumed: `packages/policy` reads it instead of hard-coding a
 * guarantee, and a Linux runner answering `enforced` requires no change above this line.
 * `unknown` exists so an adapter that cannot determine its posture fails closed (invariant 4). */
export type EgressEnforcement = 'advisory' | 'enforced' | 'unknown';

export type HostCapabilities = {
  readonly adapter_id: string;
  /** Opaque backend id, for display and support. The core branches on the booleans, never on this. */
  readonly session_backend_id: string;
  readonly egress_enforcement: EgressEnforcement;
  readonly persistent_sessions: boolean;
  readonly local_notifications: boolean;
  readonly biometric_step_up_via_webauthn: boolean;
};

/** A step the owner reads, and may paste when `is_command`. Nothing in this repo executes one. */
export type OwnerStep = { readonly instruction: string; readonly is_command: boolean };

/** Work an adapter refuses to do for itself. `why_owner_runs_it` renders next to the steps so the
 * refusal is legible rather than looking like a missing feature. */
export type OwnerProcedure = {
  readonly title: string;
  readonly why_owner_runs_it: string;
  readonly steps: readonly OwnerStep[];
};

/** Blueprint §6.1 verbatim: permissions / power / disk / unlock state. A closed set. */
export const PROBE_KINDS = ['permissions', 'power', 'disk', 'unlock'] as const;
export type ProbeKind = (typeof PROBE_KINDS)[number];

/** `unknown` is a first-class answer (invariant 1): an adapter that cannot read a value says so
 * and never substitutes a default, a last-known reading or the optimistic one. */
export type ProbeState = 'ok' | 'degraded' | 'blocked' | 'unknown';

export type HealthProbe = {
  readonly probe_id: string;
  readonly kind: ProbeKind;
  readonly state: ProbeState;
  /** The raw datum behind `state`, null when there was none to read. Never a stand-in value. */
  readonly observed: string | null;
  readonly detail: string;
  readonly checked_at: string;
  readonly procedure: OwnerProcedure | null;
};

export type HealthReport = {
  readonly checked_at: string;
  readonly probes: readonly HealthProbe[];
  readonly unresolved: readonly string[];
  /** Invariant 4: ambiguous host state refuses. False whenever `unresolved` is non-empty. */
  readonly safe_to_dispatch: boolean;
};

/** Shared, because "may the spine dispatch?" is a contract rule and not a per-adapter judgement.
 * `unknown` counts exactly as `blocked`: an unread value is not a passing one (invariant 1). */
export const summarizeProbes = (
  checked_at: string,
  probes: readonly HealthProbe[],
): HealthReport => {
  const unresolved = probes
    .filter((p) => p.state === 'unknown' || p.state === 'blocked')
    .map((p) => p.probe_id);
  return { checked_at, probes, unresolved, safe_to_dispatch: unresolved.length === 0 };
};

/** No `installed`, deliberately. These adapters write the manifest and never ask the host service
 * manager whether it took it, so "installed" is a claim they cannot honestly make.
 * `manifest_current` says exactly what was verified: the file matches the plan. */
export type AutostartState = 'not_installed' | 'divergent' | 'manifest_current' | 'unknown';
export type AutostartRegistration = 'registered' | 'not_registered' | 'unknown';

export type AutostartPlan = {
  /** Caller-supplied: naming clearance is an open gate (CLAUDE.md §1), so no id is baked in here. */
  readonly unit_id: string;
  readonly program: readonly string[];
  readonly working_directory: string;
  readonly run_at_login: boolean;
  readonly keep_alive: boolean;
  readonly log_directory: string;
  readonly environment: Readonly<Record<string, string>>;
};

export type AutostartStatus = {
  readonly unit_id: string;
  readonly state: AutostartState;
  readonly registration: AutostartRegistration;
  readonly manifest_path: string | null;
  readonly manifest_digest: string | null;
  readonly expected_digest: string | null;
  readonly detail: string;
  /** True whenever a human must act before autostart can be believed. Fails closed. */
  readonly needs_owner: boolean;
  readonly procedure: OwnerProcedure | null;
};

export type AutostartInstallResult = {
  readonly manifest_path: string;
  /** False when the bytes already matched: install is idempotent and says so. */
  readonly wrote: boolean;
  readonly digest: string;
  readonly status: AutostartStatus;
  /** Always present. Writing the manifest is the whole of what an adapter may do. */
  readonly procedure: OwnerProcedure;
};

export type AutostartRepair = {
  readonly status: AutostartStatus;
  /** File-level actions actually performed. Never a process launch. */
  readonly actions_taken: readonly string[];
  readonly procedure: OwnerProcedure | null;
  readonly needs_owner: boolean;
};

export type SessionStatus = 'live' | 'exited' | 'unknown';
export type AttachOutcome = 'created' | 'reattached' | 'refused';

export type SessionSpec = {
  readonly session_id: string;
  readonly working_directory: string;
  readonly command: readonly string[] | null;
};

export type HostSession = {
  readonly session_id: string;
  /** Opaque to the core; goes into `session.reattached.host_session_ref` verbatim. */
  readonly host_session_ref: string;
  readonly status: SessionStatus;
  readonly created_at: string | null;
  /** When the adapter last *observed* it, not when it last assumed it was fine. */
  readonly last_verified_at: string;
};

export type SessionAttachment = {
  readonly outcome: AttachOutcome;
  /** Null only when `refused`. A refusal never carries a half-known session. */
  readonly session: HostSession | null;
  readonly refused_reason: string | null;
};

/** `handed_off` is not `delivered`: a local notification surface returns no read receipt, so
 * `confirmed_at` is typed `null`. The adapter cannot supply `notification.delivered` and the type
 * says so, rather than leaving a field an implementation might fill optimistically. */
export type NotificationOutcome = 'handed_off' | 'refused' | 'failed';

export type LocalNotification = {
  readonly notification_id: string;
  readonly channel_id: string;
  readonly title: string;
  readonly body: string;
  readonly subject_kind: string;
  readonly subject_id: string;
};

export type NotificationReceipt = {
  readonly notification_id: string;
  readonly channel_id: string;
  readonly outcome: NotificationOutcome;
  readonly handed_off_at: string | null;
  readonly confirmed_at: null;
  readonly reason: string | null;
};

export type PathRefusal =
  'empty' | 'not_absolute' | 'illegal_character' | 'outside_allow_roots' | 'not_canonicalizable';

/** Discriminated so `canonical` cannot be read without checking `allowed` — the shape that makes
 * "canonicalize then use it anyway" fail to compile. */
export type PathDecision =
  | { readonly allowed: true; readonly canonical: string; readonly root: string }
  | { readonly allowed: false; readonly reason: PathRefusal; readonly detail: string };

/** Blueprint §6.2: persistent terminals are owned below the gateway; restarting it must not end a
 * session. There is no `resume` here, deliberately — reattaching a terminal is not resuming a
 * provider conversation (Seam D), and the missing method is what makes it impossible for a host
 * adapter to produce `session.resumed`. The two durable events stay distinct because the two
 * surfaces are. */
export type SessionManager = {
  /** Creates when absent, reattaches when present; the outcome says which and never guesses. */
  attach(spec: SessionSpec): Promise<SessionAttachment>;
  /** Refuses rather than creating. `session.reattached` is only honest after this succeeds. */
  reattach(session_id: string): Promise<SessionAttachment>;
  /** Rejects when the backend is unreachable: an unknown session set is not an empty one. */
  list(): Promise<readonly HostSession[]>;
};

/** `install` writes the manifest and returns the procedure. It launches no process — not to
 * register the unit, not to check on it — so `status()` reports `registration: 'unknown'`, which
 * is invariant 1 doing its job rather than a gap in the implementation. */
export type AutostartContract = {
  install(plan: AutostartPlan): Promise<AutostartInstallResult>;
  status(unit_id: string): Promise<AutostartStatus>;
  repair(plan: AutostartPlan): Promise<AutostartRepair>;
};

export type PathPolicy = {
  allow_roots(): readonly string[];
  /** Resolves symlinks before deciding. A path that cannot be resolved is refused, not allowed. */
  canonicalize(candidate: string): PathDecision;
};

export type HostAdapter = {
  capabilities(): Promise<HostCapabilities>;
  session_manager(): SessionManager;
  autostart_contract(): AutostartContract;
  path_policy(): PathPolicy;
  notify_local(notification: LocalNotification): Promise<NotificationReceipt>;
  health_probes(): Promise<HealthReport>;
};

/** The facet names in §6.1 order. `satisfies` catches a name here that is not a method; the
 * contract suite reads the declarations back out of this source to catch the other direction. */
export const HOST_ADAPTER_METHODS = [
  'session_manager',
  'autostart_contract',
  'path_policy',
  'notify_local',
  'health_probes',
  'capabilities',
] as const satisfies readonly (keyof HostAdapter)[];

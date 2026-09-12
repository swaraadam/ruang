/**
 * Migration v1 — blueprint §14.1, §14.2, §14.3.
 *
 * **This file is frozen once it lands.** Migrations are forward-only (persistence SKILL): editing
 * v1 changes the schema of every database already created from it, and nothing in SQLite would tell
 * you. `migration.test.ts` hashes the schema this produces and pins the hash, so an edit here fails
 * a test rather than diverging silently across hosts.
 *
 * **Identity columns (invariant 8, §14.2).** `owner_id` and `org_node_id` are NOT NULL on every
 * table except `owner` and `org_node` themselves, where the primary key *is* that identity — an
 * `owner.owner_id` would be a copy of `owner.id`, and an `org_node.org_node_id` likewise. The
 * exception is enumerated in the test, so it stays a recorded decision rather than an oversight.
 *
 * **`event.seq` is allocated per owner, not globally.** §15.2 and the persistence SKILL both say
 * "monotonic seq per owner". With one owner that is indistinguishable from global, which is exactly
 * why `AUTOINCREMENT` is tempting here — and why it is wrong: it would need a migration the day a
 * second owner exists, and §14.2 exists to avoid precisely that migration. `PRIMARY KEY (owner_id,
 * seq)` makes the per-owner sequence the schema's own claim; the allocating transaction is PR 2.
 *
 * **Artifact retention columns are here, not in P0-17.** `retention_class` and `sha256` land in v1
 * so the GC pass (P0-17) needs no migration to add them. Schema now, behaviour later — the reverse
 * order would mean a v2 for columns we already know the shape of.
 */
export const V1 = `
CREATE TABLE owner (
  id TEXT PRIMARY KEY, display TEXT NOT NULL,
  monthly_ceiling_cents INTEGER NOT NULL DEFAULT 0,
  credential_ref TEXT, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE org_node (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  parent_id TEXT REFERENCES org_node(id), name TEXT NOT NULL, policy_overrides TEXT
) STRICT;

-- 14.1 calls Role versioned, which needs a key grouping the versions of one logical role. id is
-- the row; name is the role. UNIQUE (owner_id, name, version) is the shape context_pack uses.
-- Without it, UNIQUE (id, version) was vacuous: id is already the primary key, so no two rows
-- could ever share one.
CREATE TABLE role (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  name TEXT NOT NULL, version INTEGER NOT NULL,
  charter TEXT NOT NULL, capabilities TEXT NOT NULL,
  context_refs TEXT, output_contract TEXT, limits TEXT, delegation TEXT,
  UNIQUE (owner_id, name, version)
) STRICT;

CREATE TABLE member (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  kind TEXT NOT NULL CHECK (kind IN ('human','agent')),
  role_ref TEXT REFERENCES role(id), display TEXT NOT NULL
) STRICT;

CREATE TABLE project (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  domain TEXT NOT NULL, adapter_binding TEXT NOT NULL, source_of_record TEXT NOT NULL,
  change_unit TEXT NOT NULL CHECK (change_unit IN ('lines','files','assets','megabytes')),
  change_budget INTEGER NOT NULL,
  evidence_floor TEXT NOT NULL CHECK (evidence_floor IN ('strong','partial','manual-required')),
  exclusive_locks TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE TABLE task (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  project_id TEXT NOT NULL REFERENCES project(id), role_id TEXT REFERENCES role(id),
  title TEXT NOT NULL, basis_ref TEXT, basis_inputs TEXT,
  execution_class TEXT NOT NULL CHECK (execution_class IN ('mechanical','standard','deep')),
  expected_reversibility TEXT NOT NULL
    CHECK (expected_reversibility IN ('revertible','compensable','irreversible')),
  acceptance_criteria TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE sandbox (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  adapter TEXT NOT NULL, kind TEXT NOT NULL, safety_record_ref TEXT, opened_at TEXT NOT NULL
) STRICT;

CREATE TABLE attempt (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  task_id TEXT NOT NULL REFERENCES task(id), sandbox_id TEXT REFERENCES sandbox(id),
  runtime_id TEXT, session_id TEXT,
  session_capture_method TEXT NOT NULL
    CHECK (session_capture_method IN ('reported','probed','unknown')),
  session_last_verified_at TEXT, lifecycle TEXT NOT NULL, started_at TEXT NOT NULL
) STRICT;

CREATE TABLE change_set (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  attempt_id TEXT REFERENCES attempt(id), summary TEXT NOT NULL,
  change_unit TEXT NOT NULL, change_size INTEGER NOT NULL,
  renderable_refs TEXT NOT NULL DEFAULT '[]', content_hash TEXT NOT NULL
) STRICT;

CREATE TABLE artifact (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  task_id TEXT REFERENCES task(id), attempt_id TEXT REFERENCES attempt(id),
  kind TEXT NOT NULL, path_ref TEXT NOT NULL, sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  retention_class TEXT NOT NULL
    CHECK (retention_class IN ('transient','task-evidence','milestone','build-cache')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE check_spec (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  required INTEGER NOT NULL CHECK (required IN (0,1)), timeout_s INTEGER NOT NULL,
  max_retries INTEGER NOT NULL DEFAULT 0,
  flake_policy TEXT NOT NULL CHECK (flake_policy IN ('mark','fail'))
) STRICT;

CREATE TABLE check_result (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  attempt_id TEXT NOT NULL REFERENCES attempt(id),
  check_spec_id TEXT NOT NULL REFERENCES check_spec(id),
  result TEXT NOT NULL CHECK (result IN ('passed','failed','skipped','flaky')),
  exit_code INTEGER, skipped_reason TEXT, artifact_ref TEXT REFERENCES artifact(id)
) STRICT;

CREATE TABLE evidence (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  attempt_id TEXT NOT NULL REFERENCES attempt(id),
  profile TEXT NOT NULL CHECK (profile IN ('strong','partial','manual-required')),
  confidence_lane TEXT NOT NULL, check_result_refs TEXT NOT NULL DEFAULT '[]',
  artifact_refs TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE TABLE steer (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  attempt_id TEXT NOT NULL REFERENCES attempt(id), intent TEXT NOT NULL,
  -- 15.3: requested -> attempted -> acknowledged | failed | unresolved. Five states, not four.
  -- attempted emits no durable event (Appendix A.1 has four steer events), so it exists only here.
  -- Omitting it would make a real state unrepresentable in a schema that cannot be edited later.
  delivery_state TEXT NOT NULL
    CHECK (delivery_state IN ('requested','attempted','acknowledged','failed','unresolved')),
  attempts INTEGER NOT NULL DEFAULT 0, resolution TEXT
) STRICT;

CREATE TABLE review_thread (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  task_id TEXT NOT NULL REFERENCES task(id), attempt_id TEXT REFERENCES attempt(id),
  anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('text_range','asset_id','node_path','region')),
  anchor_locator TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved'))
) STRICT;

CREATE TABLE review_comment (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  thread_id TEXT NOT NULL REFERENCES review_thread(id),
  author_member_id TEXT NOT NULL REFERENCES member(id),
  body TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE approval (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  task_id TEXT NOT NULL REFERENCES task(id),
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
  reversibility TEXT NOT NULL
    CHECK (reversibility IN ('revertible','compensable','irreversible')),
  reversal_plan_ref TEXT, action_fingerprint TEXT NOT NULL, target_ref TEXT NOT NULL,
  apply_plan_hash TEXT NOT NULL, decided_at TEXT, decision TEXT
) STRICT;

CREATE TABLE preview (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  task_id TEXT REFERENCES task(id), attempt_id TEXT REFERENCES attempt(id),
  port INTEGER NOT NULL, canonical_route TEXT NOT NULL,
  health TEXT NOT NULL CHECK (health IN ('starting','healthy','failed','stopped'))
) STRICT;

CREATE TABLE notification (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  channel TEXT NOT NULL, attention_item TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','delivered','opened','failed')),
  queued_at TEXT NOT NULL, delivered_at TEXT, opened_at TEXT, failure_reason TEXT
) STRICT;

CREATE TABLE repair_case (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  task_id TEXT REFERENCES task(id), probes TEXT NOT NULL DEFAULT '[]',
  affected_resources TEXT NOT NULL DEFAULT '[]', frozen_locks TEXT NOT NULL DEFAULT '[]',
  allowed_ops TEXT NOT NULL DEFAULT '[]', resolution TEXT, opened_at TEXT NOT NULL
) STRICT;

CREATE TABLE lock (
  name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  holder_task_id TEXT REFERENCES task(id), holder_attempt_id TEXT REFERENCES attempt(id),
  disposition TEXT NOT NULL CHECK (disposition IN ('active','held-by-frozen-task')),
  acquired_at TEXT NOT NULL, PRIMARY KEY (owner_id, name)
) STRICT;

CREATE TABLE budget_reservation (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  scope TEXT NOT NULL CHECK (scope IN ('owner','org_node','project','task','run')),
  scope_ref TEXT NOT NULL, reserved_cents INTEGER NOT NULL, released INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE budget_ledger (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  scope TEXT NOT NULL CHECK (scope IN ('owner','org_node','project','task','run')),
  scope_ref TEXT NOT NULL, spent_cents INTEGER NOT NULL,
  ceiling_cents INTEGER NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL
) STRICT;

CREATE TABLE host_runner (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  host_binding TEXT NOT NULL, capabilities TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE TABLE context_pack (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  name TEXT NOT NULL, version INTEGER NOT NULL,
  resource_refs TEXT NOT NULL DEFAULT '[]', UNIQUE (owner_id, name, version)
) STRICT;

CREATE TABLE event (
  owner_id TEXT NOT NULL REFERENCES owner(id),
  seq INTEGER NOT NULL,
  org_node_id TEXT NOT NULL REFERENCES org_node(id),
  ts TEXT NOT NULL, type TEXT NOT NULL,
  project_id TEXT, task_id TEXT, attempt_id TEXT,
  actor_member_id TEXT NOT NULL, actor_role_id TEXT, actor_runtime_id TEXT,
  payload TEXT NOT NULL, artifact_refs TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (owner_id, seq)
) STRICT;

CREATE INDEX event_by_type ON event (owner_id, type, seq);
CREATE INDEX event_by_task ON event (owner_id, task_id, seq);
CREATE INDEX artifact_by_retention ON artifact (owner_id, retention_class, created_at);
`;

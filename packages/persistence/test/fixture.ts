/**
 * The minimum durable rows an artifact can hang off: owner, org node, project, task, attempt.
 *
 * Real rows, not stubs. `foreign_keys` is ON for every handle, so an artifact carrying `task_id`
 * only inserts if the task exists — which is the point of testing against the actual schema rather
 * than a table of the day's convenient shape.
 */
import { type Db, openMemoryDatabase } from '../src/index.js';

export const OWNER = 'o1';
export const ORG = 'n-o1';
export const PROJECT = 'p-1';
export const TASK = 't-1';
export const ATTEMPT = 'at-1';

export const seedControlPlane = (): Db => {
  const db = openMemoryDatabase();
  const run = (sql: string, ...params: readonly unknown[]): void => {
    db.prepare(sql).run(...params);
  };
  run(`INSERT INTO owner (id, display, created_at) VALUES (?,?, 't')`, OWNER, OWNER);
  run(`INSERT INTO org_node (id, owner_id, name) VALUES (?,?, 'root')`, ORG, OWNER);
  run(
    `INSERT INTO project
       (id, owner_id, org_node_id, domain, adapter_binding, source_of_record,
        change_unit, change_budget, evidence_floor)
     VALUES (?,?,?, 'code', 'adapter.code', 'source-of-record', 'lines', 1250, 'strong')`,
    PROJECT,
    OWNER,
    ORG,
  );
  run(
    `INSERT INTO task
       (id, owner_id, org_node_id, project_id, title, execution_class,
        expected_reversibility, state, created_at)
     VALUES (?,?,?,?, 'a task', 'standard', 'revertible', 'open', '2026-01-01T00:00:00.000Z')`,
    TASK,
    OWNER,
    ORG,
    PROJECT,
  );
  run(
    `INSERT INTO attempt
       (id, owner_id, org_node_id, task_id, session_capture_method, lifecycle, started_at)
     VALUES (?,?,?,?, 'reported', 'running', '2026-01-01T00:00:00.000Z')`,
    ATTEMPT,
    OWNER,
    ORG,
    TASK,
  );
  return db;
};

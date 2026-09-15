/**
 * Declared checks and their execution (§16.1, contract-testing item 6). Checks are declared per
 * project as configuration data, and the declaration keeps the argv on this side of the seam: a
 * `CheckSpec` crossing to the core carries an id, not something to run. A check that is asked for
 * but not declared is `skipped` with a reason — never a silent pass, which is the failure mode
 * that makes a green review meaningless.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult, CheckSpec, Sandbox } from '@internal/domain';
import { runProcess } from './process.js';
import { artifactDir, sandboxPath } from './sandbox.js';
import type { CheckDeclaration, CodeAdapterOptions } from './surface.js';

/** A declared bound is still bounded when the declaration is nonsense. */
const ATTEMPT_CEILING = 5;
const boundedAttempts = (declared: number): number =>
  Math.min(ATTEMPT_CEILING, Math.max(1, Number.isSafeInteger(declared) ? declared : 1));

export const toSpec = (d: CheckDeclaration): CheckSpec => ({
  check_id: d.check_id,
  required: d.required,
  timeout_s: d.timeout_s,
  flake_policy: d.flake_policy,
  max_attempts: boundedAttempts(d.max_attempts),
});

export const declaredChecks = (o: CodeAdapterOptions): readonly CheckSpec[] =>
  (o.checks ?? []).map(toSpec);

const skipped = (check_id: string, reason: string): CheckResult => ({
  check_id,
  result: 'skipped',
  artifact_ref: null,
  skipped_reason: reason,
  attempts: 0,
});

export const runChecks = async (
  o: CodeAdapterOptions,
  sandbox: Sandbox,
  specs: readonly CheckSpec[],
): Promise<readonly CheckResult[]> => {
  const path = sandboxPath(o, sandbox.sandbox_id);
  const declarations = new Map((o.checks ?? []).map((d) => [d.check_id, d]));
  const results: CheckResult[] = [];

  for (const spec of specs) {
    const declaration = declarations.get(spec.check_id);
    if (declaration === undefined) {
      results.push(skipped(spec.check_id, 'this check is not declared for this project'));
      continue;
    }
    if (!existsSync(path)) {
      results.push(skipped(spec.check_id, 'the sandbox this check would run in is not present'));
      continue;
    }

    const bound = boundedAttempts(spec.max_attempts);
    const transcript: string[] = [];
    let attempts = 0;
    let passed = false;
    while (attempts < bound && !passed) {
      attempts += 1;
      const r = await runProcess(path, declaration.invocation, spec.timeout_s * 1000);
      passed = r.code === 0 && !r.timed_out;
      transcript.push(
        `--- attempt ${attempts} of ${bound}: ${passed ? 'passed' : r.timed_out ? 'timed out' : `failed (${r.code})`}\n${r.stdout}${r.stderr}`,
      );
    }

    // A pass that needed a retry is reported as `flaky`, not as a pass, so the two stay
    // distinguishable long after the run. `fail` is the stricter declaration and wins outright.
    const result: CheckResult['result'] = !passed
      ? 'failed'
      : attempts === 1
        ? 'passed'
        : spec.flake_policy === 'mark'
          ? 'flaky'
          : 'failed';
    const artifact_ref = writeTranscript(o, sandbox, spec.check_id, transcript.join('\n'));
    results.push({ check_id: spec.check_id, result, artifact_ref, skipped_reason: null, attempts });
  }
  return results;
};

// prettier-ignore
const writeTranscript = (o: CodeAdapterOptions, s: Sandbox, check_id: string, body: string): string => {
  const dir = artifactDir(o, s.sandbox_id);
  mkdirSync(dir, { recursive: true });
  const ref = join(dir, `${check_id.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`);
  writeFileSync(ref, body, 'utf8');
  return ref;
};

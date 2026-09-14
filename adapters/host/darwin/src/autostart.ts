/**
 * Autostart on macOS is a LaunchAgent property list under `~/Library/LaunchAgents` plus a
 * registration step. This module supplies the file, the path and the procedure; the refusal to
 * register — and therefore `registration: 'unknown'` — is `createManifestAutostart`'s.
 */
import {
  MANAGED_MARKER,
  UnsafeAutostartPlanError,
  UnsafeUnitIdError,
  assertSafeUnitId,
  createManifestAutostart,
  refuseSessionCommand,
} from '@internal/host-contract';
import type {
  AutostartContract,
  AutostartPlan,
  OwnerProcedure,
  PathPolicy,
} from '@internal/host-contract';
import { GUARDED_BINARIES, MANIFEST_MODE } from './env.js';
import type { DarwinEnv } from './env.js';

const xml = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const launchAgentsRoot = (env: DarwinEnv): string => `${env.home}/Library/LaunchAgents`;

export const manifestPath = (env: DarwinEnv, unit_id: string): string => {
  assertSafeUnitId(unit_id);
  const root = launchAgentsRoot(env);
  const path = `${root}/${unit_id}.plist`;
  // Cannot fire while the id is a bare identifier -- which is the point of asserting it first. It is
  // here because the id and the path are composed in two different places, and a later caller that
  // composes its own must not get a quieter failure than this one.
  if (!path.startsWith(`${root}/`) || path.includes('/..')) {
    throw new UnsafeUnitIdError(`refusing a manifest path outside ${root}: ${path}`);
  }
  return path;
};

/**
 * The plan is a PERSISTENCE PAYLOAD, so every field in it is a thing the machine will do at login.
 *
 * The launcher half of the `program` rule is in the shared contract, so the double enforces it too.
 * This adds the half only this host knows: the owner-run deny-list. A LaunchAgent whose program is
 * `sudo` is the foothold that list exists to refuse, and it is worse here than in a session because
 * it survives a reboot and `ownerProcedure` hands the owner a paste-ready line for it.
 *
 * Root containment is deliberately NOT applied to `program`: a real binary lives outside the
 * workspace roots, so requiring one would only teach callers to widen the roots. The two
 * directories are ordinary paths and do get it.
 */
const assertPlanIsInstallable = (paths: PathPolicy, plan: AutostartPlan): void => {
  const unsafe = refuseSessionCommand(plan.program, GUARDED_BINARIES);
  if (unsafe !== null) {
    throw new UnsafeAutostartPlanError(
      `refusing to write an autostart manifest: program ${unsafe}`,
    );
  }
  for (const [field, candidate] of [
    ['working_directory', plan.working_directory],
    ['log_directory', plan.log_directory],
  ] as const) {
    const decision = paths.canonicalize(candidate);
    if (!decision.allowed) {
      throw new UnsafeAutostartPlanError(
        `refusing to write an autostart manifest: ${field} ${decision.reason} (${decision.detail})`,
      );
    }
  }
};

export const renderManifest = (plan: AutostartPlan): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(plan.unit_id)}</string>
  <!-- ${MANAGED_MARKER}: present so this control plane will not overwrite a unit it did not write -->
  <key>ProgramArguments</key>
  <array>
${plan.program.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(plan.working_directory)}</string>
  <key>RunAtLoad</key>
  <${plan.run_at_login ? 'true' : 'false'}/>
  <key>KeepAlive</key>
  <${plan.keep_alive ? 'true' : 'false'}/>
  <key>StandardOutPath</key>
  <string>${xml(`${plan.log_directory}/${plan.unit_id}.out.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(`${plan.log_directory}/${plan.unit_id}.err.log`)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(plan.environment)
  .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
</dict>
</plist>
`;

/**
 * Display data: verbatim lines the owner reads and may paste. Nothing here executes them.
 *
 * That the adapter does not RUN these is structural — `guard` throws at the one launch site. That
 * the lines are SAFE TO PASTE is a different claim and rests on the checks above: the unit id is a
 * bare identifier, so the path is inside LaunchAgents, and the program is not a launcher. An earlier
 * version of this comment offered `GUARDED_BINARIES` as though it covered the second claim. It does
 * not, and could not: nothing is spawned on this path at all.
 */
export const ownerProcedure = (env: DarwinEnv, unit_id: string): OwnerProcedure => {
  const path = manifestPath(env, unit_id);
  const target = `gui/${env.user_id === null ? '<your-uid>' : String(env.user_id)}`;
  return {
    title: `Register and verify autostart unit ${unit_id}`,
    why_owner_runs_it:
      'Loading a LaunchAgent grants a process a login-time foothold. Writing the file is ' +
      'reversible with rm; loading it is not something an unattended agent should be able to do ' +
      'at all, so this adapter prints these lines instead of running them.',
    steps: [
      { instruction: `cat ${path}   # read it before loading it`, is_command: true },
      { instruction: `launchctl bootstrap ${target} ${path}`, is_command: true },
      { instruction: `launchctl enable ${target}/${unit_id}`, is_command: true },
      { instruction: `launchctl print ${target}/${unit_id}`, is_command: true },
      {
        instruction:
          'The status probe will still say registration "unknown" afterwards — this adapter never ' +
          'asks the service manager — so the print output above is the evidence.',
        is_command: false,
      },
    ],
  };
};

/** Unmasked on purpose: a manifest carrying a setuid or sticky bit should READ as `2644`, not be
 * quietly reported as `644`. `status` is an observation and rounding one off is inventing data. */
const octal = (mode: number): string => mode.toString(8).padStart(3, '0');

/**
 * The half of the manifest's mode that a write cannot reach.
 *
 * `env.writeFile` narrows the descriptor it writes, so a created or rewritten manifest is 0600
 * already. The gap it leaves is the UPGRADE: the same plan re-installed after this adapter changed
 * its mode policy renders identical bytes, so nothing writes, so a 0644 file an older version left
 * behind stays 0644 forever. The shared contract therefore calls this on every install and every
 * repair, body changed or not.
 *
 * The test is "any group or other bit set", not "not equal to 0600", and the direction matters: it
 * makes this function incapable of WIDENING. A manifest an owner tightened to 0400 satisfies the
 * property the security review asked for and is left exactly as it is, while 0644 and 0640 and
 * 0604 are all brought to 0600. `null` covers both "no file" and "cannot stat it", because neither
 * is a narrowing this call performed and reporting one would be inventing an action.
 */
const restrictManifestAccess = (env: DarwinEnv, path: string): string | null => {
  const mode = env.fileMode(path);
  if (mode === null || (mode & 0o077) === 0) return null;
  env.setFileMode(path, MANIFEST_MODE);
  return `narrowed ${path} from ${octal(mode)} to ${octal(MANIFEST_MODE)}`;
};

export const createAutostartContract = (env: DarwinEnv, paths: PathPolicy): AutostartContract =>
  createManifestAutostart({
    pathFor: (unit_id) => manifestPath(env, unit_id),
    // Both `install` and `repair` render before they write, so validating here covers every path
    // that puts a plan on disk without duplicating the check at each call site.
    render: (plan) => {
      assertPlanIsInstallable(paths, plan);
      return renderManifest(plan);
    },
    procedureFor: (unit_id) => ownerProcedure(env, unit_id),
    read: (path) => {
      try {
        return env.readFile(path);
      } catch {
        return null;
      }
    },
    write: env.writeFile,
    readAccess: (path) => {
      const mode = env.fileMode(path);
      return mode === null ? null : octal(mode);
    },
    restrictAccess: (path) => restrictManifestAccess(env, path),
  });

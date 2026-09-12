/**
 * Autostart on macOS is a LaunchAgent property list under `~/Library/LaunchAgents` plus a
 * registration step. This module supplies the file, the path and the procedure; the refusal to
 * register — and therefore `registration: 'unknown'` — is `createManifestAutostart`'s.
 */
import { createManifestAutostart } from '@internal/host-contract';
import type { AutostartContract, AutostartPlan, OwnerProcedure } from '@internal/host-contract';
import type { DarwinEnv } from './env.js';

const xml = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const manifestPath = (env: DarwinEnv, unit_id: string): string =>
  `${env.home}/Library/LaunchAgents/${unit_id}.plist`;

export const renderManifest = (plan: AutostartPlan): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(plan.unit_id)}</string>
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

/** Display data: verbatim lines the owner reads and may paste. Nothing here executes them, and
 * `GUARDED_BINARIES` makes that structural rather than a matter of trust. */
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

export const createAutostartContract = (env: DarwinEnv): AutostartContract =>
  createManifestAutostart({
    pathFor: (unit_id) => manifestPath(env, unit_id),
    render: renderManifest,
    procedureFor: (unit_id) => ownerProcedure(env, unit_id),
    read: (path) => {
      try {
        return env.readFile(path);
      } catch {
        return null;
      }
    },
    write: env.writeFile,
  });

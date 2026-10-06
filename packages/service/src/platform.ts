import { launchdSupervisor } from './launchd.ts';
import type { CommandRunner } from './runner.ts';
import type { Supervisor } from './supervisor.ts';
import { systemdSupervisor } from './systemd.ts';

// The platforms with a supervisor backend: systemd on Linux, launchd on macOS.
export const supported = (platform: NodeJS.Platform): boolean =>
  platform === 'linux' || platform === 'darwin';

// The backend for `platform`, a supported one, driving the user's own
// manager through `runner` as user `uid`.
export const platformSupervisor = ({
  home,
  label,
  platform,
  runner,
  uid,
}: {
  home: string;
  label: string;
  platform: NodeJS.Platform;
  runner: CommandRunner;
  uid: number;
}): Supervisor =>
  platform === 'darwin'
    ? launchdSupervisor({ home, label, runner, uid })
    : systemdSupervisor({ home, label, runner, user: String(uid) });

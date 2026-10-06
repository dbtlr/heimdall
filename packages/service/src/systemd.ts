import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { readIfPresent } from './files.ts';
import { systemdUnitPath } from './names.ts';
import type { CommandResult, CommandRunner } from './runner.ts';
import { SupervisorError, UnitNotInstalledError } from './supervisor.ts';
import type { Supervisor, UnitStatus } from './supervisor.ts';
import { renderSystemdUnit } from './unit.ts';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// `systemctl show` and `loginctl show-user` print one `Key=value` per line.
const properties = (stdout: string) =>
  new Map(
    stdout.split('\n').flatMap((line) => {
      const at = line.indexOf('=');
      return at > 0 ? [[line.slice(0, at), line.slice(at + 1).trim()] as const] : [];
    }),
  );

// The unit's state in plain words: `running (pid N)`, `stopped`, or systemd's
// own active state, with its sub-state when that adds something.
const activity = (props: Map<string, string>) => {
  const active = props.get('ActiveState') ?? 'unknown';
  const sub = props.get('SubState') ?? '';
  const pid = Number(props.get('MainPID') ?? '0');
  if (active === 'active' && Number.isInteger(pid) && pid > 0) {
    return { running: true, words: `running (pid ${String(pid)})` };
  }
  if (active === 'inactive') {
    return { running: false, words: 'stopped' };
  }
  return { running: false, words: sub === '' || sub === active ? active : `${active} (${sub})` };
};

// The systemd user-unit backend. Every command is `systemctl --user`, so the
// unit runs in the calling user's manager, from `~/.config/systemd/user/`.
// `user` names the user (or uid) whose linger `status` reads.
export const systemdSupervisor = ({
  home,
  label,
  runner,
  user,
}: {
  home: string;
  label: string;
  runner: CommandRunner;
  user: string;
}): Supervisor => {
  const unitName = `${label}.service`;
  const unit = systemdUnitPath(home, label);

  // A host without systemd has no systemctl; that is a failed command, not a crash.
  const attempt = async (argv: readonly string[]): Promise<CommandResult> => {
    try {
      return await runner(argv);
    } catch (error) {
      throw new SupervisorError(
        `${argv[0] ?? 'command'} is not available: ${describeError(error)}`,
      );
    }
  };

  const systemctl = async (...argv: string[]) => {
    const result = await attempt(['systemctl', '--user', ...argv]);
    if (result.code !== 0) {
      const said = result.stderr.trim();
      throw new SupervisorError(
        `systemctl --user ${argv[0] ?? ''} failed (exit ${String(result.code)})${said === '' ? '' : `: ${said}`}`,
      );
    }
    return result.stdout;
  };

  const installed = async () => (await readIfPresent(unit)) !== undefined;

  const needsReload = async () =>
    properties(await systemctl('show', unitName, '--property=NeedDaemonReload')).get(
      'NeedDaemonReload',
    ) === 'yes';

  const onInstalledUnit = (verb: 'restart' | 'start' | 'stop') => async () => {
    if (!(await installed())) {
      throw new UnitNotInstalledError(label);
    }
    await systemctl(verb, unitName);
  };

  // Linger keeps a user's units running with no login session. Status only
  // reads it: turning it on is the operator's decision.
  const lingerNotes = async () => {
    try {
      const result = await runner(['loginctl', 'show-user', user, '--property=Linger']);
      return result.code === 0 && properties(result.stdout).get('Linger') === 'no'
        ? ['linger is off; the unit stops at logout']
        : [];
    } catch {
      return [];
    }
  };

  const unitState = async (): Promise<Pick<UnitStatus, 'running' | 'stateKnown' | 'summary'>> => {
    try {
      const props = properties(
        await systemctl('show', unitName, '--property=LoadState,ActiveState,SubState,MainPID'),
      );
      const { running, words } = activity(props);
      return {
        running,
        stateKnown: true,
        summary: `${props.get('LoadState') ?? 'unknown'}, ${words}`,
      };
    } catch (error) {
      const reason = describeError(error).replace(/:.*$/su, '');
      return { running: false, stateKnown: false, summary: `state unknown (${reason})` };
    }
  };

  return {
    install: async (definition) => {
      const text = renderSystemdUnit(definition);
      const unitWritten = (await readIfPresent(unit)) !== text;
      if (unitWritten) {
        await mkdir(dirname(unit), { recursive: true });
        await writeFile(unit, text);
      }
      // An unchanged file may still be newer than the manager's copy, such as
      // one restored by hand; the manager says so.
      if (unitWritten || (await needsReload())) {
        await systemctl('daemon-reload');
      }
      await systemctl('enable', unitName);
      // Always restart: that is how a new binary or a changed config file takes effect.
      await systemctl('restart', unitName);
      return { unitWritten };
    },
    restart: onInstalledUnit('restart'),
    start: onInstalledUnit('start'),
    status: async () => {
      const present = await installed();
      const state = present
        ? await unitState()
        : { running: false, stateKnown: true, summary: 'not installed' };
      return { installed: present, notes: await lingerNotes(), unit, ...state };
    },
    stop: onInstalledUnit('stop'),
    // `disable` needs the unit file, and the reload must not find it, so the
    // file goes between them.
    uninstall: async () => {
      if (!(await installed())) {
        return { removed: false };
      }
      await systemctl('stop', unitName);
      await systemctl('disable', unitName);
      await rm(unit, { force: true });
      await systemctl('daemon-reload');
      return { removed: true };
    },
    unit,
  };
};

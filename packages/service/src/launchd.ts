import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { readIfPresent } from './files.ts';
import { isServiceNotLoaded, readPrintedService } from './launchctl.ts';
import type { PrintedService } from './launchctl.ts';
import { launchdPlistPath } from './names.ts';
import { renderLaunchdPlist } from './plist.ts';
import type { CommandResult, CommandRunner } from './runner.ts';
import { SupervisorError, UnitNotInstalledError } from './supervisor.ts';
import type { Supervisor, UnitStatus } from './supervisor.ts';

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The exit codes launchctl gives for a `bootout` or a domain `print` of
// something that is not there: 113, and 3 "No such process" from some releases'
// bootout. Neither prints the "Could not find service" message that `print` of
// a service does, so they are judged by code alone; `print` of the service goes
// through `isServiceNotLoaded`, which also needs the message.
const NOT_LOADED_CODES = new Set([3, 113]);

// `bootout` can return, or report 36 "Operation now in progress", before
// launchd has torn the agent down. Every bootout therefore waits, up to
// UNLOAD_WAIT_MS, until `print` no longer finds the agent.
const BOOTOUT_IN_PROGRESS_CODE = 36;
const UNLOAD_WAIT_MS = 15_000;

// A bootstrap while launchd still settles can fail with 5 (Input/output
// error) or 37 (Operation already in progress). Those two are retried for up
// to BOOTSTRAP_RETRY_MS, as Mimir's launchd backend retries 5; any other
// failure surfaces at once.
const BOOTSTRAP_RETRY_CODES = new Set([5, 37]);
const BOOTSTRAP_RETRY_MS = 5000;

// How long to pause between two looks at launchd while it settles.
const POLL_MS = 250;

// Linux's linger note has a macOS counterpart: with no GUI login session
// there is no domain to load the agent into.
const NO_SESSION_NOTE = 'no GUI login session; the agent loads when the user logs in';

// A launchctl command that failed, with what launchctl said.
const failure = (verb: string, result: CommandResult) => {
  const said = result.stderr.trim();
  return new SupervisorError(
    `launchctl ${verb} failed (exit ${String(result.code)})${said === '' ? '' : `: ${said}`}`,
  );
};

// The agent's state in plain words, as systemd's backend words its own:
// `running (pid N)`, `stopped`, or launchd's state, such as `spawn scheduled`.
const activity = ({ pid, running, state }: PrintedService) => {
  if (running) {
    return {
      running,
      words: pid === undefined || pid === 0 ? 'running' : `running (pid ${String(pid)})`,
    };
  }
  return { running, words: state === 'not running' ? 'stopped' : (state ?? 'unknown') };
};

// The launchd user-agent backend. The plist lives in `~/Library/LaunchAgents/`
// and loads into the user's GUI domain, `gui/<uid>`, so the agent runs while
// the user is logged in and loads again at each login.
//
// KeepAlive relaunches a killed process, so `stop` boots the agent out of the
// domain, leaving the plist on disk, and `start` bootstraps it back, as
// Mimir's backend does. `restart` is `kickstart -k` on a loaded agent. A
// bootstrap starts the binary itself (RunAtLoad), so a command that has just
// bootstrapped never kickstarts too. A stopped agent reads `not loaded, stopped`.
// `now` and `sleep` time the waits for launchd to settle.
export const launchdSupervisor = ({
  home,
  label,
  now = Date.now,
  runner,
  sleep = Bun.sleep,
  uid,
}: {
  home: string;
  label: string;
  now?: () => number;
  runner: CommandRunner;
  sleep?: (ms: number) => Promise<void>;
  uid: number;
}): Supervisor => {
  const domain = `gui/${String(uid)}`;
  const service = `${domain}/${label}`;
  const unit = launchdPlistPath(home, label);

  // A host without launchctl is a failed command, not a crash.
  const attempt = async (argv: readonly string[]): Promise<CommandResult> => {
    try {
      return await runner(['launchctl', ...argv]);
    } catch (error) {
      throw new SupervisorError(`launchctl is not available: ${describeError(error)}`);
    }
  };

  const launchctl = async (...argv: string[]) => {
    const result = await attempt(argv);
    if (result.code !== 0) {
      throw failure(argv[0] ?? '', result);
    }
  };

  const installed = async () => (await readIfPresent(unit)) !== undefined;

  // The service as launchctl prints it, or undefined when it is not loaded.
  const printed = async () => {
    const result = await attempt(['print', service]);
    if (result.code === 0) {
      return readPrintedService(result.stdout);
    }
    if (isServiceNotLoaded(result)) {
      return undefined;
    }
    throw failure('print', result);
  };

  const isLoaded = async () => (await printed()) !== undefined;

  const untilUnloaded = async (deadline: number): Promise<void> => {
    if (!(await isLoaded())) {
      return;
    }
    if (now() >= deadline) {
      throw new SupervisorError(
        `${label} is still loaded ${String(UNLOAD_WAIT_MS / 1000)} s after launchctl bootout`,
      );
    }
    await sleep(POLL_MS);
    await untilUnloaded(deadline);
  };

  // Takes the agent out of the domain and returns once launchd has let it go.
  const bootout = async () => {
    const result = await attempt(['bootout', service]);
    if (NOT_LOADED_CODES.has(result.code)) {
      return;
    }
    if (result.code !== 0 && result.code !== BOOTOUT_IN_PROGRESS_CODE) {
      throw failure('bootout', result);
    }
    await untilUnloaded(now() + UNLOAD_WAIT_MS);
  };

  const bootstrap = async (deadline = now() + BOOTSTRAP_RETRY_MS): Promise<void> => {
    const result = await attempt(['bootstrap', domain, unit]);
    if (result.code === 0) {
      return;
    }
    if (!BOOTSTRAP_RETRY_CODES.has(result.code) || now() >= deadline) {
      throw failure('bootstrap', result);
    }
    await sleep(POLL_MS);
    await bootstrap(deadline);
  };

  // The session note, when the GUI domain itself is missing. Read-only; a
  // domain that cannot be asked adds nothing.
  const sessionNotes = async () => {
    try {
      const result = await attempt(['print', domain]);
      return NOT_LOADED_CODES.has(result.code) ? [NO_SESSION_NOTE] : [];
    } catch {
      return [];
    }
  };

  const requireInstalled = async () => {
    if (!(await installed())) {
      throw new UnitNotInstalledError(label);
    }
  };

  const unitState = async (): Promise<
    Pick<UnitStatus, 'notes' | 'running' | 'stateKnown' | 'summary'>
  > => {
    try {
      const printedService = await printed();
      if (printedService === undefined) {
        return {
          notes: await sessionNotes(),
          running: false,
          stateKnown: true,
          summary: 'not loaded, stopped',
        };
      }
      const { running, words } = activity(printedService);
      return { notes: [], running, stateKnown: true, summary: `loaded, ${words}` };
    } catch (error) {
      const reason = describeError(error).replace(/:.*$/su, '');
      return {
        notes: [],
        running: false,
        stateKnown: false,
        summary: `state unknown (${reason})`,
      };
    }
  };

  return {
    install: async (definition) => {
      const text = renderLaunchdPlist(definition);
      const unitWritten = (await readIfPresent(unit)) !== text;
      const wasLoaded = await isLoaded();
      // A disabled service cannot be bootstrapped, so enable comes first.
      await launchctl('enable', service);
      // launchd keeps the plist it loaded; a changed file loads only by
      // booting the old copy out and bootstrapping the new one. The file is
      // written once launchd has let the old copy go, so a failure before
      // then leaves it as it was and the next install still sees the change.
      if (unitWritten && wasLoaded) {
        await bootout();
      }
      if (unitWritten) {
        await mkdir(dirname(unit), { recursive: true });
        await writeFile(unit, text);
      }
      // Always restart, which is how a new binary or a changed config file
      // takes effect: a fresh load starts the binary, or kickstart restarts it.
      await (unitWritten || !wasLoaded ? bootstrap() : launchctl('kickstart', '-k', service));
      return { unitWritten };
    },
    restart: async () => {
      await requireInstalled();
      await ((await isLoaded()) ? launchctl('kickstart', '-k', service) : bootstrap());
    },
    // Without -k, kickstart starts a loaded agent that is not running and
    // leaves a running one alone, as `systemctl start` does.
    start: async () => {
      await requireInstalled();
      await ((await isLoaded()) ? launchctl('kickstart', service) : bootstrap());
    },
    status: async () => {
      const present = await installed();
      const state = present
        ? await unitState()
        : { notes: [], running: false, stateKnown: true, summary: 'not installed' };
      return { installed: present, unit, ...state };
    },
    stop: async () => {
      await requireInstalled();
      await bootout();
    },
    // The plist goes only after the agent is out of the domain, so a failed
    // bootout leaves an agent that `uninstall` can try again.
    uninstall: async () => {
      if (!(await installed())) {
        return { removed: false };
      }
      await bootout();
      await rm(unit, { force: true });
      return { removed: true };
    },
    unit,
  };
};

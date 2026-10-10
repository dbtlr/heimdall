import type { CommandResult } from '../subprocess.ts';
import type { ServiceOutcome } from './services.ts';

// launchctl lives here on every macOS. A launchd agent has a minimal PATH, so
// the Collector runs it by absolute path.
const LAUNCHCTL = '/bin/launchctl';

// launchctl's exit status for a target it has no service for.
const NOT_FOUND_EXIT_CODE = 113;

type LaunchdOutcome = Pick<ServiceOutcome, 'detail' | 'state'>;

// What asking one domain came to: the service's loaded state, or that the
// domain does not have it, or that the Collector could not ask.
type DomainAnswer = { kind: 'answered'; outcome: LaunchdOutcome } | { kind: 'not loaded' };

const unknown = (detail: string): LaunchdOutcome => ({ detail, state: 'unknown' });

// The fields launchctl prints for the service itself: one tab in. A block
// inside the service, such as an endpoint with a state and pid of its own, is
// two tabs in or more and is not the service's.
const field = (stdout: string, name: string) =>
  new RegExp(`^\\t${name} = (.+)$`, 'mu').exec(stdout)?.[1]?.trim();

// The state of a service launchctl printed. A process makes it up, whether
// launchctl says `state = running` or only gives a pid. A service that is
// loaded with no process, which includes one waiting to be started again after
// it exited, is stopped, with the status it last exited with. Output without
// the service's state is not about a service the Collector can judge.
const loadedOutcome = (stdout: string): LaunchdOutcome => {
  const state = field(stdout, 'state');
  if (state === undefined) {
    return unknown('unexpected launchctl output');
  }
  if (state === 'running') {
    return { detail: 'state = running', state: 'up' };
  }
  const pid = field(stdout, 'pid');
  if (pid !== undefined && /^\d+$/u.test(pid)) {
    return { detail: `pid = ${pid}`, state: 'up' };
  }
  const exitCode = field(stdout, 'last exit code');
  return {
    detail: `state = ${state}${exitCode === undefined ? '' : `, last exit code = ${exitCode}`}`,
    state: 'stopped',
  };
};

// Asks launchctl about one service target such as `gui/501/<label>`. Only the
// exit status 113 with launchctl's "Could not find service" means the domain
// does not have it; any other failure is a launchctl that could not answer.
const askDomain = async (
  run: (cmd: readonly string[]) => Promise<CommandResult>,
  target: string,
): Promise<DomainAnswer> => {
  let result: CommandResult;
  try {
    result = await run([LAUNCHCTL, 'print', target]);
  } catch {
    return { kind: 'answered', outcome: unknown('launchctl could not run') };
  }
  if (result.kind === 'timed out') {
    return { kind: 'answered', outcome: unknown('launchctl timed out') };
  }
  if (result.exitCode === 0) {
    return { kind: 'answered', outcome: loadedOutcome(result.stdout) };
  }
  if (
    result.exitCode === NOT_FOUND_EXIT_CODE &&
    /Could not find service/iu.test(`${result.stderr}\n${result.stdout}`)
  ) {
    return { kind: 'not loaded' };
  }
  return { kind: 'answered', outcome: unknown(`launchctl exited ${String(result.exitCode)}`) };
};

// Asks launchd whether a label is running: first in the gui domain of the
// account the Collector runs as, where a user agent lives, then in the system
// domain, where a daemon lives. A label neither domain has loaded is stopped. A
// domain that fails to answer makes the check unknown without asking the next,
// since the label may be loaded there.
export const launchdOutcome = async (
  {
    run,
    uid,
  }: { run: (cmd: readonly string[]) => Promise<CommandResult>; uid?: number | undefined },
  label: string,
): Promise<LaunchdOutcome> => {
  if (uid === undefined) {
    return unknown('no user id for the gui domain');
  }
  for (const domain of [`gui/${String(uid)}`, 'system']) {
    // oxlint-disable-next-line no-await-in-loop -- the system domain is asked only if the gui domain does not have the label.
    const answer = await askDomain(run, `${domain}/${label}`);
    if (answer.kind === 'answered') {
      return answer.outcome;
    }
  }
  return { detail: 'not loaded', state: 'stopped' };
};

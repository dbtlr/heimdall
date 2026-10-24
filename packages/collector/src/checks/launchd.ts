import { isServiceNotLoaded, readPrintedService } from '@heimdall/service';

import type { CommandResult } from '../subprocess.ts';
import { supervisorOutcome } from './outcome.ts';
import type { ServiceOutcome } from './outcome.ts';
import type { CountedStopFacts } from './stop-log.ts';

// launchctl lives here on every macOS. A launchd agent has a minimal PATH, so
// the Collector runs it by absolute path.
const LAUNCHCTL = '/bin/launchctl';

type Run = (cmd: readonly string[]) => Promise<CommandResult>;

// What asking one domain came to: the outcome for a service the domain has
// loaded or could not answer for, or that the domain does not have it.
type DomainAnswer = { kind: 'answered'; outcome: ServiceOutcome } | { kind: 'not loaded' };

const answered = (outcome: ServiceOutcome): DomainAnswer => ({ kind: 'answered', outcome });

// How a service's last run ended, as launchctl printed it: by a signal, with
// its number, which launchctl gives after the signal's name, as in `Killed: 9`;
// otherwise by its exit code, cleanly for 0. A service that never exited, or
// a code the Hub cannot take, ended in a way the Collector does not know.
const lastExit = (
  exitCode: string | undefined,
  signal: string | undefined,
): Pick<CountedStopFacts, 'exitStatus' | 'result'> => {
  if (signal !== undefined) {
    const number = /(?:^|\D)(\d{1,9})$/u.exec(signal)?.[1];
    return { exitStatus: number === undefined ? null : Number(number), result: 'signal' };
  }
  if (exitCode !== undefined && /^\d{1,9}$/u.test(exitCode)) {
    const status = Number(exitCode);
    return { exitStatus: status, result: status === 0 ? 'success' : 'exit-code' };
  }
  return { exitStatus: null, result: null };
};

// What launchd holds about a label that the stop log compares (ADR-0021): its
// runs, the pid of its process, and how its last run ended. A label neither
// domain has loaded has no process and no runs.
const NOT_LOADED_FACTS: CountedStopFacts = {
  exitStatus: null,
  pid: null,
  result: null,
  running: false,
  runs: 0,
};

// The outcome for a service launchctl printed. A process makes it up, whether
// launchctl says `state = running` or only gives a pid. A service that is
// loaded with no process, which includes one waiting to be started again after
// it exited, is stopped, with the status it last exited with and the signal
// that ended it, when launchctl printed them. Output without the service's
// state is not about a service the Collector can judge. A known state carries
// the service's stop facts when launchctl printed its runs.
const loadedOutcome = (stdout: string): ServiceOutcome => {
  const { exitCode, pid, running, runs, signal, state } = readPrintedService(stdout);
  if (state === undefined) {
    return supervisorOutcome('unknown', 'unexpected launchctl output');
  }
  const outcome = running
    ? supervisorOutcome('up', `state = ${state}`)
    : supervisorOutcome(
        'stopped',
        [
          `state = ${state}`,
          ...(exitCode === undefined ? [] : [`last exit code = ${exitCode}`]),
          ...(signal === undefined ? [] : [`last terminating signal = ${signal}`]),
        ].join(', '),
      );
  if (runs === undefined) {
    return outcome;
  }
  const stopFacts: CountedStopFacts = {
    ...lastExit(exitCode, signal),
    pid: running ? (pid ?? null) : null,
    running,
    runs,
  };
  return { ...outcome, stopFacts };
};

// Asks launchctl about one service target such as `gui/501/<label>`. Only what
// `isServiceNotLoaded` accepts means the domain does not have it; any other
// failure is a launchctl that could not answer.
const askDomain = async (run: Run, target: string): Promise<DomainAnswer> => {
  let result: CommandResult;
  try {
    result = await run([LAUNCHCTL, 'print', target]);
  } catch {
    return answered(supervisorOutcome('unknown', 'launchctl could not run'));
  }
  if (result.kind === 'timed out') {
    return answered(supervisorOutcome('unknown', 'launchctl timed out'));
  }
  const { exitCode: code, stderr, stdout } = result;
  if (code === 0) {
    return answered(loadedOutcome(stdout));
  }
  if (isServiceNotLoaded({ code, stderr, stdout })) {
    return { kind: 'not loaded' };
  }
  return answered(supervisorOutcome('unknown', `launchctl exited ${String(code)}`));
};

// Asks launchd whether a label is running: first in the GUI login domain of the
// account the Collector runs as, `gui/<uid>`, where its user agents live, then
// in the system domain, where daemons live. A label neither domain has loaded
// is stopped. A domain that fails to answer makes the check unknown without
// asking the next, since the label may be loaded there.
export const launchdOutcome = async (
  { run, uid }: { run: Run; uid?: number | undefined },
  label: string,
): Promise<ServiceOutcome> => {
  if (uid === undefined) {
    return supervisorOutcome('unknown', 'no user id for the gui domain');
  }
  for (const domain of [`gui/${String(uid)}`, 'system']) {
    // oxlint-disable-next-line no-await-in-loop -- the system domain is asked only if the gui domain does not have the label.
    const answer = await askDomain(run, `${domain}/${label}`);
    if (answer.kind === 'answered') {
      return answer.outcome;
    }
  }
  return { ...supervisorOutcome('stopped', 'not loaded'), stopFacts: NOT_LOADED_FACTS };
};

import { isServiceNotLoaded, readPrintedService } from '@heimdall/service';

import type { CommandResult } from '../subprocess.ts';
import { supervisorOutcome } from './outcome.ts';
import type { ServiceOutcome } from './outcome.ts';

// launchctl lives here on every macOS. A launchd agent has a minimal PATH, so
// the Collector runs it by absolute path.
const LAUNCHCTL = '/bin/launchctl';

type Run = (cmd: readonly string[]) => Promise<CommandResult>;

// What asking one domain came to: the outcome for a service the domain has
// loaded or could not answer for, or that the domain does not have it.
type DomainAnswer = { kind: 'answered'; outcome: ServiceOutcome } | { kind: 'not loaded' };

const answered = (outcome: ServiceOutcome): DomainAnswer => ({ kind: 'answered', outcome });

// The outcome for a service launchctl printed. A process makes it up, whether
// launchctl says `state = running` or only gives a pid. A service that is
// loaded with no process, which includes one waiting to be started again after
// it exited, is stopped, with the status it last exited with and the signal
// that ended it, when launchctl printed them. Output without the service's
// state is not about a service the Collector can judge.
const loadedOutcome = (stdout: string): ServiceOutcome => {
  const { exitCode, running, signal, state } = readPrintedService(stdout);
  if (state === undefined) {
    return supervisorOutcome('unknown', 'unexpected launchctl output');
  }
  if (running) {
    return supervisorOutcome('up', `state = ${state}`);
  }
  return supervisorOutcome(
    'stopped',
    [
      `state = ${state}`,
      ...(exitCode === undefined ? [] : [`last exit code = ${exitCode}`]),
      ...(signal === undefined ? [] : [`last terminating signal = ${signal}`]),
    ].join(', '),
  );
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
  return supervisorOutcome('stopped', 'not loaded');
};

import type {
  RecordedApplication,
  RecordedFiles,
  RecordedJob,
  RecordedService,
  ScheduleEntry,
} from '../server/system-detail-types.ts';
import { formatSpan, formatWhen } from './time.ts';

// How a recorded thing stands, as its dot shows it.
export type RecordState = 'bad' | 'good' | 'unknown' | 'warning';

type At = { now: number; timeZone: string };

const SUPERVISOR_NAMES: Record<string, string> = {
  docker: 'Docker',
  launchd: 'launchd',
  systemd: 'systemd',
  'systemd-user': 'systemd user',
};

const STATE_WORDS: Record<string, string> = {
  stopped: 'Stopped',
  unchecked: 'Not checked',
  unhealthy: 'Unhealthy',
  unknown: 'Unknown',
  up: 'Up',
};

// A check's detail as the end of a sentence, without a doubled full stop.
const tail = (detail: string) => (detail === '' ? '' : `: ${detail.replace(/\.$/u, '')}`);

// What a Service's checks say: its supervisor's check first, then whether its
// health URL answers. Bad when any check found it stopped or unhealthy,
// unknown when any could not tell.
export const serviceLine = (
  service: RecordedService,
  { now, timeZone }: At,
): { state: RecordState; text: string } => {
  if (service.checks.length === 0) {
    return { state: 'unknown', text: 'Not checked yet.' };
  }
  const parts = service.checks.map((check) => {
    const since = formatWhen(check.since, now, timeZone);
    if (check.check === 'health') {
      return check.state === 'up'
        ? 'Health URL answers.'
        : `Health check ${check.state === 'unhealthy' ? 'failing' : (STATE_WORDS[check.state] ?? check.state).toLowerCase()} since ${since}${tail(check.detail)}.`;
    }
    const supervisor = SUPERVISOR_NAMES[service.supervisor];
    const under = supervisor === undefined ? '' : ` (${supervisor})`;
    return `${STATE_WORDS[check.state] ?? check.state} since ${since}${under}${check.state === 'up' ? '' : tail(check.detail)}.`;
  });
  const states = new Set(service.checks.map(({ state }) => state));
  let state: RecordState = 'good';
  if (states.has('stopped') || states.has('unhealthy')) {
    state = 'bad';
  } else if ([...states].some((found) => found !== 'up')) {
    state = 'unknown';
  }
  return { state, text: parts.join(' ') };
};

const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

const hhmm = (hour: number, minute: number) =>
  `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

// A job's schedule in words for the common shapes, else how many times it names.
export const scheduleWords = (schedule: readonly ScheduleEntry[]): string => {
  const [only] = schedule;
  if (only === undefined) {
    return 'No schedule';
  }
  if (schedule.length === 1) {
    const { day, hour, minute, month, weekday } = only;
    const fields = Object.keys(only).toSorted().join(',');
    if (fields === 'minute' && minute !== undefined) {
      return minute === 0 ? 'Hourly' : `Hourly at :${String(minute).padStart(2, '0')}`;
    }
    if (month === undefined && hour !== undefined && minute !== undefined) {
      if (fields === 'hour,minute') {
        return `Daily at ${hhmm(hour, minute)}`;
      }
      if (fields === 'hour,minute,weekday' && weekday !== undefined) {
        return `${WEEKDAYS[weekday % 7] ?? ''} at ${hhmm(hour, minute)}`;
      }
      if (fields === 'day,hour,minute' && day !== undefined) {
        return `Monthly on day ${String(day)} at ${hhmm(hour, minute)}`;
      }
    }
  }
  return `${String(schedule.length)} scheduled ${schedule.length === 1 ? 'time' : 'times'}`;
};

// A job's schedule and how its latest run went. Bad when it is failing, a
// warning when it is overdue, unknown when it has never run.
export const jobLine = (
  job: RecordedJob,
  { now, timeZone }: At,
): { state: RecordState; text: string } => {
  const schedule = `${scheduleWords(job.schedule)}.`;
  const run = job.latestRun;
  if (run === undefined) {
    return { state: 'unknown', text: `${schedule} No run recorded yet.` };
  }
  const took = formatSpan(run.finished - run.started);
  const outcome =
    run.exitStatus === 0
      ? `succeeded in ${took}`
      : `failed with exit status ${String(run.exitStatus)} after ${took}`;
  const overdue = job.open.includes('job_overdue');
  let state: RecordState = 'good';
  if (job.open.includes('job_failing') || run.exitStatus !== 0) {
    state = 'bad';
  } else if (overdue) {
    state = 'warning';
  }
  return {
    state,
    text: `${schedule} Last run ${formatWhen(run.started, now, timeZone)}, ${outcome}.${overdue ? ' Overdue.' : ''}`,
  };
};

const ISSUE_WORDS: Record<string, string> = {
  drifted: 'drifted',
  missing: 'missing',
  unreadable: 'cannot be read',
};

const files = (count: number) =>
  count === 1 ? '1 file matches.' : `${String(count)} files match.`;

// A files record's state: each file that does not match, since when, and how
// many others match. A warning for Drift, unknown when files only cannot be
// read or the Collector has not checked this version of the record.
export const filesLine = (
  record: RecordedFiles,
  { now, timeZone }: At,
): { issues: { path: string; text: string }[]; rest: string; state: RecordState } => {
  if (!record.checked) {
    return { issues: [], rest: 'Not checked yet.', state: 'unknown' };
  }
  const others = record.count - record.issues.length;
  let rest = '';
  if (record.issues.length === 0) {
    rest = files(record.count);
  } else if (others > 0) {
    rest = others === 1 ? '1 other file matches.' : `${String(others)} other files match.`;
  }
  let state: RecordState = 'good';
  if (record.issues.some((issue) => issue.state !== 'unreadable')) {
    state = 'warning';
  } else if (record.issues.length > 0) {
    state = 'unknown';
  }
  return {
    issues: record.issues.map((issue) => ({
      path: issue.path,
      text: `${ISSUE_WORDS[issue.state] ?? issue.state} since ${formatWhen(issue.since, now, timeZone)}`,
    })),
    rest,
    state,
  };
};

// An application's version and where it came from.
export const applicationLine = (application: RecordedApplication): string =>
  application.source === undefined
    ? application.version
    : `${application.version}, ${application.source}`;

// Who recorded the applications, once for each provisioner and revision, or
// undefined when none says.
export const provenanceLine = (
  applications: readonly RecordedApplication[],
): string | undefined => {
  const who = [
    ...new Set(
      applications.flatMap(({ provenance }) =>
        provenance === undefined
          ? []
          : [
              provenance.revision === undefined
                ? provenance.by
                : `${provenance.by} at ${provenance.revision}`,
            ],
      ),
    ),
  ];
  if (who.length === 0) {
    return undefined;
  }
  const last = who.pop();
  return `Recorded by ${who.length === 0 ? '' : `${who.join(', ')} and `}${last ?? ''}.`;
};

import type { CommandResult } from './runner.ts';

// launchctl's exit status for a target it has no service for.
const NOT_FOUND_CODE = 113;

// Whether `launchctl print <domain>/<label>` said the domain has no such
// service. Both signs are needed: the exit status 113, and launchctl's "Could
// not find service" message, on either stream and in any case. A 113 about a
// domain, or the message under another status, is a launchctl that could not
// answer, not a service that is not loaded.
export const isServiceNotLoaded = ({ code, stderr, stdout }: CommandResult) =>
  code === NOT_FOUND_CODE && /could not find service/iu.test(`${stderr}\n${stdout}`);

// launchctl's exit status for a GUI domain that does not exist.
const NO_DOMAIN_CODE = 112;

// Whether `launchctl print` said the domain itself is missing, as a GUI domain
// is when the user has no login session. Like `isServiceNotLoaded`, it needs
// both the exit status 112 and launchctl's "Could not find domain" message, on
// either stream and in any case.
export const isDomainMissing = ({ code, stderr, stdout }: CommandResult) =>
  code === NO_DOMAIN_CODE && /could not find domain/iu.test(`${stderr}\n${stdout}`);

// The service's own properties from `launchctl print`: the lines one tab in,
// `key = value`. Nested blocks sit deeper and are skipped, so the state or pid
// of an endpoint or a coalition inside the service is never taken for its own.
const topLevel = (stdout: string) =>
  new Map(
    stdout.split('\n').flatMap((line) => {
      const match = /^\t([^\t=][^=]*?) = (.*)$/u.exec(line);
      return match?.[1] === undefined || match[2] === undefined
        ? []
        : [[match[1], match[2].trim()] as const];
    }),
  );

// What `launchctl print` says about a loaded service. `running` is true for
// `state = running` and for a pid made of digits, whatever the state says.
// `runs` is how many times launchd started it since it was loaded, or
// undefined when launchctl printed no count of digits. `state` is undefined
// when launchctl printed none, or only whitespace.
export type PrintedService = {
  exitCode: string | undefined;
  pid: number | undefined;
  running: boolean;
  runs: number | undefined;
  signal: string | undefined;
  state: string | undefined;
};

const digits = (text: string | undefined) =>
  text !== undefined && /^\d+$/u.test(text) ? Number(text) : undefined;

export const readPrintedService = (stdout: string): PrintedService => {
  const props = topLevel(stdout);
  const pid = digits(props.get('pid'));
  const state = props.get('state') || undefined;
  return {
    exitCode: props.get('last exit code'),
    pid,
    running: state === 'running' || pid !== undefined,
    runs: digits(props.get('runs')),
    signal: props.get('last terminating signal'),
    state,
  };
};

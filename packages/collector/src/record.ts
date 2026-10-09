import {
  ApplicationRecordSchema,
  FilesRecordSchema,
  JobRecordSchema,
  RECORD_NAME,
  RunRecordSchema,
  ServiceRecordSchema,
} from '@heimdall/schema';
import type { RecordKind, RecordOf } from '@heimdall/schema';
import { homeOf } from '@heimdall/service';
import { Command, escapeControlCharacters } from '@loomcli/core';
import type { Host } from '@loomcli/core';
import { text } from '@loomcli/validators';

import { describeError } from './errors.ts';
import { parseJson } from './json.ts';
import type { Checker } from './json.ts';
import { stateDir } from './options.ts';
import { openRecords } from './records.ts';
import type { RecordStore } from './records.ts';
import { defaultStateDir } from './state-dir.ts';

// The most a record command reads from standard input. A record of 10,000 files
// is well under it.
const MAX_INPUT_BYTES = 1024 * 1024;

// The most problems an error lists, so a badly wrong record stays readable.
const MAX_ISSUES_LISTED = 10;
const MAX_ISSUE_CHARACTERS = 200;

// The parts of a Loom action context these commands use.
type Context = {
  host: Pick<Host, 'env' | 'stdin' | 'terminal'>;
  options: { 'state-dir'?: string | undefined };
  out: { fatal: (message: string) => never; print: (message: string) => Promise<void> };
  style: { escape: (text: string) => string };
};

// Plain text out, with control characters and markup shown literally. Each line
// is escaped alone, so the line breaks between them stay.
const io = ({ host, options, out, style }: Context) => {
  const clean = (message: string) =>
    message
      .split('\n')
      .map((line) => style.escape(escapeControlCharacters(line)))
      .join('\n');
  const fail: (message: string) => never = (message) => out.fatal(clean(message));
  return {
    fail,
    print: (message: string) => out.print(clean(message)),
    stateDir:
      options['state-dir'] ??
      defaultStateDir({ env: host.env, home: homeOf(host.env), platform: process.platform }),
  };
};

type Io = ReturnType<typeof io>;

// The text on standard input. A terminal is refused, since a person who typed
// `record` with no pipe would otherwise wait on a prompt that never comes.
const readInput = async (context: Context, place: Io): Promise<string> => {
  if (context.host.terminal.stdin.isTTY) {
    return place.fail(
      'Standard input is a terminal. Pipe a JSON record to this command, such as: echo \'{"name": "webapp", "version": "1.0.0"}\' | heimdall-collector record application',
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of context.host.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_INPUT_BYTES) {
      return place.fail('The record is over 1 MiB, which is the most this command reads.');
    }
    chunks.push(buffer);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return place.fail('Standard input is not valid UTF-8.');
  }
};

const pathWords = (path: readonly PropertyKey[]): string =>
  path.length === 0
    ? 'the record'
    : path.reduce<string>(
        (words, segment) =>
          typeof segment === 'number'
            ? `${words}[${String(segment)}]`
            : `${words === '' ? '' : `${words}.`}${String(segment)}`,
        '',
      );

// The problems a schema found, each with its field path and what is wrong. The
// messages Zod and the schemas write name rules and field names, never the input.
const problems = (error: {
  issues: readonly { message: string; path: readonly PropertyKey[] }[];
}): string => {
  const listed = error.issues.slice(0, MAX_ISSUES_LISTED).map((issue) => {
    const message = `${pathWords(issue.path)}: ${issue.message}`;
    return `  ${message.length > MAX_ISSUE_CHARACTERS ? `${message.slice(0, MAX_ISSUE_CHARACTERS)}...` : message}`;
  });
  const more = error.issues.length - listed.length;
  return [...listed, ...(more > 0 ? [`  and ${String(more)} more`] : [])].join('\n');
};

// The JSON value on standard input, checked against `schema`. A failure exits 1
// and never quotes the input, which may hold a secret.
const readRecord = async <T>(
  context: Context,
  place: Io,
  { description, schema }: { description: string; schema: Checker<T> },
): Promise<T> => {
  const input = await readInput(context, place);
  if (input.trim() === '') {
    return place.fail(`Standard input is empty. Pipe one JSON ${description} to this command.`);
  }
  const value = parseJson(input);
  if (value === undefined) {
    return place.fail(`Standard input is not valid JSON. Pipe one JSON ${description}.`);
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? parsed.data
    : place.fail(`The ${description} is not valid:\n${problems(parsed.error)}`);
};

const checkedName = (place: Io, name: string): string =>
  RECORD_NAME.test(name)
    ? name
    : place.fail(
        'The name is not valid: it takes 1 to 128 letters, digits, dots, underscores, and hyphens, and starts with a letter or digit.',
      );

// Runs `use` on the store in the state directory, which is created if missing.
// A store that will not open, or a write that fails, exits 1.
const withStore = async <T>(place: Io, use: (store: RecordStore) => T): Promise<T> => {
  const store = await openRecords({ stateDir: place.stateDir }).catch((error: unknown) =>
    place.fail(
      `Could not open the records in the state directory ${place.stateDir}: ${describeError(error)}`,
    ),
  );
  try {
    return use(store);
  } catch (error) {
    return place.fail(
      `Could not update the records in the state directory ${place.stateDir}: ${describeError(error)}`,
    );
  } finally {
    store.close();
  }
};

const KIND_DESCRIPTIONS = {
  application:
    'Record an Application from one JSON object on standard input: name, version, and optionally source and provenance.',
  files:
    'Record files from one JSON object on standard input: name and a list of absolute paths with their SHA-256 hashes, and optionally provenance.',
  job: 'Record a scheduled job from one JSON object on standard input: name, scheduler (launchd or systemd-timer), its label or unit, and its calendar schedule.',
  service:
    'Record a Service from one JSON object on standard input: name, supervisor (systemd, systemd-user, launchd, docker, or none), its unit, label, or container, and optionally a loopback health URL and port.',
} as const satisfies Record<RecordKind, string>;

const recordKind = <K extends RecordKind>(kind: K, schema: Checker<RecordOf<K>>) =>
  new Command(kind, { description: KIND_DESCRIPTIONS[kind] })
    .option('state-dir', stateDir)
    .action(async (context) => {
      const place = io(context);
      const record = await readRecord(context, place, {
        description: `${kind} record`,
        schema,
      });
      await withStore(place, (store) => {
        store.put(kind, record);
      });
      await place.print(`Recorded ${kind} ${record.name}.`);
    });

const recordRun = new Command('run', {
  description:
    'Record one run of a recorded job from one JSON object on standard input: started and finished (UTC, whole seconds), exitStatus (0 is success), and optionally output as a file name and sizeBytes.',
})
  .argument('job', {
    description: 'The name of the job that ran, which must be recorded with record job.',
    required: true,
    validate: text({ minLength: 1 }),
  })
  .option('state-dir', stateDir)
  .action(async (context) => {
    const place = io(context);
    const job = checkedName(place, context.args.job);
    const run = await readRecord(context, place, { description: 'run', schema: RunRecordSchema });
    const kept = await withStore(place, (store) => store.putRun(job, run));
    if (!kept) {
      place.fail(`No job ${job} is recorded. Record it with record job before its runs.`);
    }
    await place.print(`Recorded run of ${job} started ${run.started}.`);
  });

// `heimdall-collector record <kind>`: keeps what a provisioner installed in the
// Collector's own state (ADR-0011).
export const recordCommand = new Command('record', {
  description: 'Record what a provisioner installed on this System, from JSON on standard input.',
})
  .command(recordKind('application', ApplicationRecordSchema))
  .command(recordKind('service', ServiceRecordSchema))
  .command(recordKind('job', JobRecordSchema))
  .command(recordKind('files', FilesRecordSchema))
  .command(recordRun);

const forgetKind = (kind: RecordKind) =>
  new Command(kind, {
    description: `Remove a recorded ${kind}${kind === 'job' ? ' and its runs' : ''}. Succeeds when none is recorded.`,
  })
    .argument('name', {
      description: `The name of the ${kind} record.`,
      required: true,
      validate: text({ minLength: 1 }),
    })
    .option('state-dir', stateDir)
    .action(async (context) => {
      const place = io(context);
      const name = checkedName(place, context.args.name);
      const removed = await withStore(place, (store) => store.forget(kind, name));
      await place.print(removed ? `Forgot ${kind} ${name}.` : `No ${kind} ${name} is recorded.`);
    });

// `heimdall-collector forget <kind> <name>`: removes a record, so an uninstall
// script can run it whether or not the thing was ever recorded.
export const forgetCommand = new Command('forget', {
  description: 'Remove a record of something a provisioner installed on this System.',
})
  .command(forgetKind('application'))
  .command(forgetKind('service'))
  .command(forgetKind('job'))
  .command(forgetKind('files'));

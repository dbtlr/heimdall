import { once } from 'node:events';
import type { Writable } from 'node:stream';

import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler, Host } from '@loomcli/core';

import type { deleteTranscripts, showTranscript } from './application.ts';
import { withDatabase } from './commands.ts';
import { PARSERS } from './projection.ts';
import {
  locateGeneration,
  locateRequest,
  locateSessionTranscript,
  TranscriptNotFoundError,
  writeHeldLines,
  writeRequestLines,
} from './transcript-reader.ts';
import { deleteTranscripts as deleteGenerations } from './transcripts.ts';

const count = (n: number, noun: string) =>
  `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;

// `heimdall-hub transcripts delete`: deletes whole generations matching every
// filter given, or with --dry-run says what it would delete (ADR-0013). At
// least one filter is required, so no typo deletes the whole archive.
export const deleteTranscriptsAction: ActionHandler<typeof deleteTranscripts> = async ({
  options,
  out,
  signal,
  style,
}) => {
  const { before, source, system } = options;
  if (before === undefined && source === undefined && system === undefined) {
    out.fatal('Name what to delete with --system, --source, or --before.');
  }
  const dryRun = options['dry-run'] ?? false;
  const removed = await withDatabase(options.database, { out, signal, style }, (sql) =>
    deleteGenerations(sql, {
      dryRun,
      now: Date.now(),
      ...(before === undefined ? {} : { before: Date.parse(`${before}T00:00:00Z`) }),
      ...(source === undefined ? {} : { source }),
      ...(system === undefined ? {} : { system }),
    }),
  );
  await out.print(
    `${dryRun ? 'Would delete' : 'Deleted'} ${count(removed.generations, 'generation')} of transcripts, ${count(removed.bytes, 'gzipped byte')}.`,
  );
};

// Writes `data`, waiting for the stream to drain when it asks to.
const writeTo = async (stream: Writable, data: string | Uint8Array) => {
  if (!stream.write(data)) {
    await once(stream, 'drain');
  }
};

// Text as a terminal shows it: every control character but the newline escaped.
const shown = (text: string) => text.split('\n').map(escapeControlCharacters).join('\n');

// Where `transcripts show` writes content: stdout, as the bytes the Hub holds
// when it is piped, and with every control character escaped on a terminal,
// so no line a transcript holds can drive the terminal. `end` writes what a
// terminal's decoder still holds, a sequence the content ended inside, as a
// replacement character.
const contentWriter = (host: Host) => {
  if (!host.terminal.stdout.isTTY) {
    return {
      end: async () => {},
      write: (bytes: Uint8Array) => writeTo(host.stdout, bytes),
    };
  }
  const decoder = new TextDecoder();
  return {
    end: async () => {
      const rest = decoder.decode();
      if (rest !== '') {
        await writeTo(host.stdout, shown(rest));
      }
    },
    write: (bytes: Uint8Array) =>
      writeTo(host.stdout, shown(decoder.decode(bytes, { stream: true }))),
  };
};

// `heimdall-hub transcripts show`: prints, as raw JSONL on stdout, a
// Session's transcript, the main conversation or with --agent a subagent's;
// every line of a request; or a generation a locator names, whole or from
// --offset through the end of that line. It reads with the Hub's own database
// access, so it runs on the Hub's System. Anything else it says, such as
// migrations it applied, goes to stderr, so stdout holds only the transcript.
export const showTranscriptAction: ActionHandler<typeof showTranscript> = async ({
  host,
  options,
  out,
  signal,
  style,
}) => {
  const { agent, generation, offset, path, request, session, source, system } = options;
  const named = [session, request, generation].filter((value) => value !== undefined).length;
  if (named === 0) {
    out.fatal(
      'Name a Session with --session, a request with --request, or a locator with --generation.',
    );
  }
  if (named > 1) {
    out.fatal('Name only one of --session, --request, and --generation.');
  }
  if (generation === undefined && (system === undefined || source === undefined)) {
    out.fatal('A Session or a request needs --system and --source.');
  }
  if (generation === undefined && (path !== undefined || offset !== undefined)) {
    out.fatal('--path and --offset go with --generation.');
  }
  if (agent !== undefined && session === undefined) {
    out.fatal('--agent goes with --session.');
  }
  const context = {
    out: {
      fatal: (message: string) => out.fatal(message),
      print: (message: string) => out.info(message),
      warn: (message: string) => out.warn(message),
    },
    signal,
    style,
  };
  const { end, write } = contentWriter(host);
  await withDatabase(options.database, context, async (sql) => {
    if (request !== undefined) {
      const held = await locateRequest(sql, {
        request,
        source: source ?? '',
        system: system ?? '',
      });
      const parser = PARSERS.find((candidate) => candidate.harness === held.harness);
      if (parser === undefined) {
        throw new TranscriptNotFoundError(`No parser for ${held.harness} reads its requests.`);
      }
      await writeRequestLines(
        sql,
        { generations: held.generations, request, requestIdOf: parser.requestIdOf },
        write,
      );
    } else {
      const held =
        session === undefined
          ? await locateGeneration(sql, {
              generation: generation ?? 0,
              ...(path === undefined ? {} : { path }),
              ...(source === undefined ? {} : { source }),
              ...(system === undefined ? {} : { system }),
            })
          : await locateSessionTranscript(sql, {
              session,
              source: source ?? '',
              system: system ?? '',
              ...(agent === undefined ? {} : { agent }),
            });
      await writeHeldLines(
        sql,
        { ...held, from: offset ?? 0, oneLine: offset !== undefined },
        write,
      );
    }
    await end();
  });
};

import { RECORD_NAME, SOURCE_NAME, SYSTEM_NAME } from '@heimdall/schema';
import { serviceCommand } from '@heimdall/service';
import { Application, Command } from '@loomcli/core';
import { config } from '@loomcli/plugins/config';
import { configInput } from '@loomcli/plugins/config/extension';
import { help } from '@loomcli/plugins/help';
import { version } from '@loomcli/plugins/version';
import { date, integer, text, url } from '@loomcli/validators';

import { deliveryTestAction } from './delivery-commands.ts';
import { duration } from './duration.ts';
import { INSIGHT_READER_ROLE } from './insight-reader.ts';
import { pairAction, unpairAction } from './pair-commands.ts';
import { purgeServiceAction, purgeSystemAction } from './purge-commands.ts';
import { serveAction } from './serve.ts';
import { silenceAction } from './silence-commands.ts';
import { deleteTranscriptsAction, showTranscriptAction } from './transcript-commands.ts';
import { HUB_VERSION, versionPostfix } from './version.ts';

// SIGTERM from systemd and SIGINT from a terminal cancel `serve`, and it gets
// this long to finish its running jobs, stop listening, and close its database
// connections before the signal ends the process. Loom's default of 500 ms can
// cut that short.
const shutdown = { timeout: 10_000 };

// The database every command opens, from its flag, then its variable, then
// `[database] url` in the configuration file, where Fleet's secret path reaches it.
const database = {
  description: 'PostgreSQL connection URL.',
  env: 'HEIMDALL_DATABASE_URL',
  extensions: [configInput({ path: 'database.url' })],
  required: true,
  type: 'string',
  validate: url({ protocols: ['postgres', 'postgresql'] }),
} as const;

// Each `serve` setting comes from its flag, then its variable, then the
// configuration file.
export const serve = new Command('serve', {
  description: 'Accept Reports and transcripts from Collectors.',
})
  .option('database', database)
  .option('host', {
    default: '127.0.0.1',
    description: 'Address to listen on.',
    env: 'HEIMDALL_HOST',
    extensions: [configInput({ path: 'host' })],
    type: 'string',
    validate: text({ minLength: 1 }),
  })
  .option('port', {
    default: '8080',
    description: 'TCP port to listen on; 0 picks a free one.',
    env: 'HEIMDALL_PORT',
    extensions: [configInput({ path: 'port' })],
    type: 'string',
    validate: integer({ max: 65_535, min: 0 }),
  })
  .option('price-overrides', {
    description:
      'JSON file of model prices that add to or replace the bundled list prices, dated like them.',
    env: 'HEIMDALL_PRICE_OVERRIDES',
    extensions: [configInput({ path: 'prices.overrides' })],
    type: 'string',
    validate: text({ minLength: 1 }),
  })
  // The role the provisioner creates to read the insight views, and nothing
  // else. Unset, serve grants no role anything.
  .option('insight-reader', {
    description:
      'PostgreSQL role to let read the insight views as serve starts. The provisioner creates it.',
    env: 'HEIMDALL_INSIGHT_READER',
    extensions: [configInput({ path: 'database.insight_reader' })],
    type: 'string',
    validate: text({
      message: 'Use a lowercase PostgreSQL role name, such as heimdall_insight.',
      pattern: INSIGHT_READER_ROLE,
    }),
  })
  .action(serveAction);

// The System a `pair`, `unpair`, `silence`, or `purge` names, by Fleet's System name rule.
const system = {
  description: 'The Fleet System name, such as laptop-1.',
  required: true,
  validate: text({ message: 'Use a Fleet System name, such as laptop-1.', pattern: SYSTEM_NAME }),
} as const;

export const pair = new Command('pair', {
  description:
    'Issue a Pairing code for a System. On that System, heimdall-collector pair <code> redeems it.',
})
  .argument('system', system)
  .option('database', database)
  .action(pairAction);

export const unpair = new Command('unpair', {
  description: "Revoke a System's token and any pending Pairing code. Its history stays.",
})
  .argument('system', system)
  .option('database', database)
  .action(unpairAction);

export const silence = new Command('silence', {
  description:
    'Hold alert delivery for a System for a time, such as --for 2h. Its Conditions stay on the dashboard. With no System, list the silences; with --clear, end one.',
})
  .argument('system', { ...system, required: false })
  .option('for', {
    description: 'How long to hold delivery: days, hours, and minutes, such as 30m, 2h, or 1d12h.',
    type: 'string',
    validate: duration(),
  })
  .option('clear', {
    description: "End the System's silence, so delivery resumes.",
    type: 'boolean',
  })
  .option('database', database)
  .action(silenceAction);

export const purgeSystem = new Command('system', {
  description:
    'Delete everything the Hub holds for an unpaired System. Its transcripts stay unless --transcripts.',
})
  .argument('system', system)
  .option('transcripts', {
    description: "Delete the System's transcripts and the Session insight derived from them too.",
    type: 'boolean',
  })
  .option('database', database)
  .action(purgeSystemAction);

export const purgeService = new Command('service', {
  description:
    "Delete a forgotten Service's stops and Conditions with their Timeline from one System. The System must no longer record it.",
})
  .argument('system', system)
  .argument('service', {
    description: 'The Service, as its record names it, such as web.',
    required: true,
    validate: text({ message: 'Use a record name, such as web.', pattern: RECORD_NAME }),
  })
  .option('database', database)
  .action(purgeServiceAction);

const purge = new Command('purge', {
  description: 'Delete what the Hub holds for something retired.',
})
  .command(purgeSystem)
  .command(purgeService);

export const deleteTranscripts = new Command('delete', {
  description:
    'Delete whole generations of transcripts that match every filter given. A path whose every generation is deleted is refused from then on.',
})
  .option('system', {
    description: 'Only the transcripts of this System.',
    type: 'string',
    validate: text({ message: 'Use a Fleet System name, such as laptop-1.', pattern: SYSTEM_NAME }),
  })
  .option('source', {
    description: 'Only the transcripts of this source, such as claude-code, on any System.',
    type: 'string',
    validate: text({ message: 'Use a source name, such as claude-code.', pattern: SOURCE_NAME }),
  })
  .option('before', {
    description:
      'Only generations last uploaded before the start of this day in UTC, such as 2026-01-01.',
    type: 'string',
    validate: date(),
  })
  .option('dry-run', {
    description: 'Say what would be deleted, and delete nothing.',
    type: 'boolean',
  })
  .option('database', database)
  .action(deleteTranscriptsAction);

export const showTranscript = new Command('show', {
  description:
    "Print raw JSONL transcript lines: a Session's with --session, a request's with --request, or a generation's or the line at a locator with --generation.",
})
  .option('system', {
    description: 'The System the transcript is from. A Session or a request needs it.',
    type: 'string',
    validate: text({ message: 'Use a Fleet System name, such as laptop-1.', pattern: SYSTEM_NAME }),
  })
  .option('source', {
    description:
      'The source the transcript is from, such as claude-code. A Session or a request needs it.',
    type: 'string',
    validate: text({ message: 'Use a source name, such as claude-code.', pattern: SOURCE_NAME }),
  })
  .option('session', {
    description: "The Session's id, as the insight views name it. Prints its main conversation.",
    type: 'string',
    validate: text({ minLength: 1 }),
  })
  .option('agent', {
    description: "With --session, prints this subagent's transcript instead.",
    type: 'string',
    validate: text({ minLength: 1 }),
  })
  .option('request', {
    description:
      "A request's id, as the insight views name it. Prints every line of it, as its Harness's parser reads them.",
    type: 'string',
    validate: text({ minLength: 1 }),
  })
  .option('path', {
    description: 'With --generation, the path within the source the generation must be of.',
    type: 'string',
    validate: text({ minLength: 1 }),
  })
  .option('generation', {
    description: 'The generation a locator names. Alone, prints the whole generation.',
    type: 'string',
    validate: integer({ min: 1 }),
  })
  .option('offset', {
    description: "With --generation, the locator's byte offset. Prints the line that starts there.",
    type: 'string',
    validate: integer({ min: 0 }),
  })
  .option('database', database)
  .action(showTranscriptAction);

const transcripts = new Command('transcripts', {
  description: 'Manage the archive of agent Session transcripts.',
})
  .command(showTranscript)
  .command(deleteTranscripts);

export const deliveryTest = new Command('test', {
  description:
    "Send one low-priority test message through the [delivery] channel, to check that alerts can reach a phone. A message that gets through ends the dashboard's delivery failing status.",
})
  .option('database', database)
  .action(deliveryTestAction);

const delivery = new Command('delivery', {
  description: 'Check how the Hub delivers alerts.',
}).command(deliveryTest);

// The `heimdall-hub` command line. `main.ts` runs it against the process.
export const app = new Application('heimdall-hub', {
  description: 'Store Reports from every System and serve the dashboard.',
  plugins: [
    help(),
    version({ postfix: versionPostfix }),
    config({ file: '.config/heimdall/hub.{toml,json}' }),
  ],
  shutdown,
  version: HUB_VERSION,
})
  .command(serve)
  .command(pair)
  .command(unpair)
  .command(silence)
  .command(purge)
  .command(transcripts)
  .command(delivery)
  .command(serviceCommand({ binary: 'hub', version: HUB_VERSION }));

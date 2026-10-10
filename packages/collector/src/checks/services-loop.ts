import { RECORD_NAME } from '@heimdall/schema';
import type { SentServiceCheck, ServiceRecord } from '@heimdall/schema';
import { every, httpGet as defaultHttpGet } from '@heimdall/service';

import type { Log } from '../collector.ts';
import { describeError } from '../errors.ts';
import type { RecordStore } from '../records.ts';
import { describeRows } from '../sections-report.ts';
import { runCommand } from '../subprocess.ts';
import type { CheckParts } from './parts.ts';
import { checkService, findSystemctl } from './services.ts';
import type { ServiceTools } from './services.ts';

// How often the Services are checked.
export const SERVICE_CHECK_INTERVAL_MS = 60_000;

// The service records among the stored ones. A row stored under a name other
// than its own, or under one the checks section cannot carry, is left out and
// reported in `refused`: the Hub refuses a whole Report, Vitals with it, for
// one entry it cannot take.
const serviceRecordsOf = (stored: ReturnType<RecordStore['readRecords']>['records']) => {
  const refused: string[] = [];
  const records: ServiceRecord[] = [];
  for (const { kind, name, record } of stored) {
    if (kind !== 'service' || !('supervisor' in record)) {
      continue;
    }
    if (record.name === name && RECORD_NAME.test(name)) {
      records.push(record);
    } else {
      refused.push(JSON.stringify(name));
    }
  }
  return { records, refused };
};

// What the supervisor knows a Service by: the unit, label or container, or
// nothing for a Service that has no supervisor.
const targetOf = (record: ServiceRecord) => {
  switch (record.supervisor) {
    case 'systemd':
    case 'systemd-user': {
      return record.unit;
    }
    case 'launchd': {
      return record.label;
    }
    case 'docker': {
      return record.container;
    }
    case 'none': {
      return null;
    }
    default: {
      const _exhaustive: never = record;
      return _exhaustive;
    }
  }
};

// Names one check of one Service as recorded: a Service recorded again under
// another supervisor or target is a different Service to check, so it starts
// a `since` of its own.
const keyOf = (record: ServiceRecord, check: SentServiceCheck['check']) =>
  JSON.stringify([record.name, record.supervisor, targetOf(record), check]);

// The checks of every Service the Collector's provisioner recorded, run on a
// cadence of their own so a Service that stops is seen within a minute, however
// long the file checks take. Each tick checks every `service` record and
// builds the services part of the checks section; the part is replaced only
// when something in it changed, so the same object is answered until then and a
// Service whose state holds causes no resend.
//
// A check's `since` is when this Collector's clock first saw it in its current
// state, kept while the Collector runs. It holds a connection to the store of
// its own, opened on the first tick and again on each tick until it opens, so a
// database that cannot be opened costs the checks, never the daemon. `latest`
// answers the part, or undefined before the first tick finishes and while the
// last tick failed. `tick` never throws.
export const createServiceChecks = ({
  findSystemctl: locateSystemctl = findSystemctl,
  httpGet = defaultHttpGet,
  log,
  now,
  open,
  run = runCommand,
}: {
  findSystemctl?: () => Promise<string | undefined>;
  httpGet?: ServiceTools['httpGet'];
  log: Log;
  now: () => number;
  open: () => Promise<RecordStore>;
  run?: ServiceTools['run'];
}) => {
  let store: RecordStore | undefined;
  let previous = new Map<string, SentServiceCheck>();
  let latest: CheckParts | undefined;
  let warnedAbout = '';
  let failing = false;

  const pass = async (held: RecordStore) => {
    const { records, refused } = serviceRecordsOf(held.readRecords().records);
    const warning = refused.join(', ');
    if (refused.length > 0 && warning !== warnedAbout) {
      log.warn(
        `Left out of the Service checks, since the Hub cannot take their names: ${describeRows(refused)}.`,
      );
    }
    warnedAbout = warning;
    const tools = { httpGet, run, systemctl: await locateSystemctl(), uid: process.getuid?.() };
    const checkedAt = now();
    // In the order the store lists the records, by name, so the part is the same
    // while nothing changes.
    const found = (
      await Promise.all(
        records.map(async (record) =>
          (await checkService(record, tools)).map(({ check, detail, state }) => {
            const key = keyOf(record, check);
            const before = previous.get(key);
            return {
              key,
              sent: {
                check,
                detail,
                service: record.name,
                since: before?.state === state ? before.since : checkedAt,
                state,
              },
            };
          }),
        ),
      )
    ).flat();
    previous = new Map(found.map(({ key, sent }) => [key, sent]));
    const sent = found.map((entry) => entry.sent);
    if (JSON.stringify(sent) !== JSON.stringify(latest?.services)) {
      latest = { services: sent };
    }
  };

  return {
    close: () => {
      store?.close();
      store = undefined;
    },
    latest: () => latest,
    tick: async () => {
      try {
        store ??= await open();
        await pass(store);
        failing = false;
      } catch (error) {
        if (!failing) {
          log.warn(`Could not read the records to check their Services: ${describeError(error)}`);
        }
        failing = true;
        // Results the Collector can no longer make are not reported, so the
        // Hub holds what it has instead of counting a stale state, and every
        // `since` starts afresh once the checks work again.
        previous = new Map();
        latest = undefined;
      }
    },
  };
};

// Runs the Service checks beside the file checks, every interval after the
// last tick finishes. The returned function stops the loop, waits for a tick in
// flight, and closes the store.
export const startServiceChecks = ({
  intervalMs = SERVICE_CHECK_INTERVAL_MS,
  ...options
}: Parameters<typeof createServiceChecks>[0] & { intervalMs?: number }) => {
  const checks = createServiceChecks(options);
  const stop = every({
    intervalMs,
    onError: (error) => options.log.warn(`Checking Services failed: ${describeError(error)}`),
    task: checks.tick,
  });
  return {
    latest: checks.latest,
    stop: async () => {
      await stop();
      checks.close();
    },
  };
};

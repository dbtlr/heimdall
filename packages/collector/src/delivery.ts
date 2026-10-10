import { MAX_REPORT_BYTES, MAX_SAMPLES_PER_REPORT, REPORT_SCHEMA_VERSION } from '@heimdall/schema';
import type { RecordsSection, Report, RunsSection, TranscriptsSection } from '@heimdall/schema';

import { describeError } from './errors.ts';
import type { SampleQueue } from './queue.ts';

// How the Hub answered one Report (ADR-0004). Only a rejected Report is dropped;
// a failed one stays queued for the next attempt.
export type Delivery =
  | { kind: 'delivered' }
  | { detail: string; kind: 'rejected' }
  | { kind: 'failed'; reason: string };

const HTTP_UNPROCESSABLE = 422;
const SEND_TIMEOUT_MS = 30_000;

// The Hub endpoint at `path` under the Hub's base URL, which may carry a path prefix.
export const hubEndpoint = (hub: URL, path: string) => {
  const base = new URL(hub);
  if (!base.pathname.endsWith('/')) {
    base.pathname += '/';
  }
  return new URL(path, base);
};

// Sends one Report to the Hub's ingest endpoint and reads the answer.
export const sendReport = async ({
  hub,
  report,
  signal,
  token,
}: {
  hub: URL;
  report: Report;
  signal?: AbortSignal;
  token: string;
}): Promise<Delivery> => {
  const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(hubEndpoint(hub, 'api/v1/reports'), {
      body: JSON.stringify(report),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      method: 'POST',
      // A redirect would turn the POST into a GET whose answer says nothing about the Report.
      redirect: 'manual',
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
  } catch (error) {
    return { kind: 'failed', reason: `Hub unreachable: ${describeError(error)}` };
  }
  if (response.status >= 200 && response.status < 300) {
    await response.body?.cancel();
    return { kind: 'delivered' };
  }
  if (response.status === HTTP_UNPROCESSABLE) {
    return { detail: await response.text().catch(() => ''), kind: 'rejected' };
  }
  await response.body?.cancel();
  return { kind: 'failed', reason: `Hub answered ${String(response.status)}` };
};

// Who sends the Reports: the System and this Collector build.
export type ReportIdentity = Pick<Report, 'collector' | 'system'>;

// A section waiting for a Report. The caller says how the Hub answered the
// Report that carried it; a failed delivery is not settled, so the section is
// offered again.
export type PendingSection<Section> = {
  section: Section;
  settle: (outcome: Exclude<Delivery, { kind: 'failed' }>) => void;
};

// The sections that are due, each ready to ride on a Report.
export type PendingSections = {
  records?: PendingSection<RecordsSection>;
  runs?: PendingSection<RunsSection>;
};

// Where `flushQueue` asks for the records and runs sections to put in a Report.
export type SectionsSource = { pending: () => Promise<PendingSections> };

export type Rejection = { detail: string; samples: number };

export type FlushResult =
  | { delivered: number; kind: 'drained'; rejected: Rejection[] }
  | { delivered: number; kind: 'failed'; reason: string; rejected: Rejection[] };

// Sends the queued backlog oldest first, in Reports of at most `batchSize`
// samples, until the queue is empty or a delivery fails. Every Report carries
// the transcripts section as it stands when the Report is sent (ADR-0013), and
// the System's time zone when it has one. The pending records and runs sections
// are asked for once per flush and ride on the first Report that stays within
// the Hub's cap. A Report that would exceed it goes without them, and they stay
// pending, not settled, for a later and smaller Report, such as the end of a
// backlog. If the Hub refuses a Report carrying them, its samples are sent again
// without them, so the sections never cost Vitals; only a refused Report without
// them drops its samples. One 422 settles every section the Report carried, so
// a section the Hub refuses holds back the other until the hourly refresh.
export const flushQueue = async ({
  batchSize = MAX_SAMPLES_PER_REPORT,
  identity,
  now,
  queue,
  sections,
  send,
  timeZone,
  transcripts,
}: {
  batchSize?: number;
  identity: ReportIdentity;
  now: () => number;
  queue: SampleQueue;
  sections: SectionsSource;
  send: (report: Report) => Promise<Delivery>;
  timeZone: () => string | undefined;
  transcripts: () => TranscriptsSection;
}): Promise<FlushResult> => {
  let delivered = 0;
  let waiting: PendingSections | undefined;
  const rejected: Rejection[] = [];
  for (;;) {
    const samples = queue.oldest(batchSize);
    const last = samples.at(-1);
    if (last === undefined) {
      return { delivered, kind: 'drained', rejected };
    }
    // oxlint-disable-next-line no-await-in-loop -- batches go one at a time, oldest first.
    waiting ??= await sections.pending();
    const zone = timeZone();
    const base: Report = {
      ...identity,
      samples,
      schemaVersion: REPORT_SCHEMA_VERSION,
      sentAt: Math.trunc(now()),
      ...(zone === undefined ? {} : { timeZone: zone }),
      transcripts: transcripts(),
    };
    const reportWith = (carried: Pick<Report, 'records' | 'runs'>): Report => ({
      ...base,
      ...carried,
    });
    const { records, runs } = waiting;
    const withSections = reportWith({
      ...(records === undefined ? {} : { records: records.section }),
      ...(runs === undefined ? {} : { runs: runs.section }),
    });
    const carrying =
      (records !== undefined || runs !== undefined) &&
      Buffer.byteLength(JSON.stringify(withSections)) <= MAX_REPORT_BYTES;
    // oxlint-disable-next-line no-await-in-loop -- batches go one at a time, oldest first.
    let outcome = await send(carrying ? withSections : reportWith({}));
    if (carrying && outcome.kind !== 'failed') {
      waiting = {};
      records?.settle(outcome);
      runs?.settle(outcome);
      if (outcome.kind === 'rejected') {
        // oxlint-disable-next-line no-await-in-loop -- the same batch, once more.
        outcome = await send(reportWith({}));
      }
    }
    switch (outcome.kind) {
      case 'delivered': {
        delivered += samples.length;
        break;
      }
      case 'rejected': {
        rejected.push({ detail: outcome.detail, samples: samples.length });
        break;
      }
      case 'failed': {
        return { delivered, kind: 'failed', reason: outcome.reason, rejected };
      }
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
    queue.removeThrough(last.t);
  }
};

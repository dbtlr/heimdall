import { MAX_SAMPLES_PER_REPORT, REPORT_SCHEMA_VERSION } from '@heimdall/schema';
import type { RecordsSection, Report, TranscriptsSection } from '@heimdall/schema';

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

// A records section waiting for a Report. The caller says how the Hub answered
// the Report that carried it; a failed delivery is not settled, so the section
// is offered again.
export type PendingRecords = {
  section: RecordsSection;
  settle: (outcome: Exclude<Delivery, { kind: 'failed' }>) => void;
};

// Where `flushQueue` asks for a records section to put in a Report.
export type RecordsSource = { pending: () => PendingRecords | undefined };

export type Rejection = { detail: string; samples: number };

export type FlushResult =
  | { delivered: number; kind: 'drained'; rejected: Rejection[] }
  | { delivered: number; kind: 'failed'; reason: string; rejected: Rejection[] };

// Sends the queued backlog oldest first, in Reports of at most `batchSize`
// samples, until the queue is empty or a delivery fails. Every Report carries
// the transcripts section as it stands when the Report is sent (ADR-0013). A
// pending records section rides on the first Report of the flush only.
export const flushQueue = async ({
  batchSize = MAX_SAMPLES_PER_REPORT,
  identity,
  now,
  queue,
  records,
  send,
  transcripts,
}: {
  batchSize?: number;
  identity: ReportIdentity;
  now: () => number;
  queue: SampleQueue;
  records: RecordsSource;
  send: (report: Report) => Promise<Delivery>;
  transcripts: () => TranscriptsSection;
}): Promise<FlushResult> => {
  let delivered = 0;
  let firstReport = true;
  const rejected: Rejection[] = [];
  for (;;) {
    const samples = queue.oldest(batchSize);
    const last = samples.at(-1);
    if (last === undefined) {
      return { delivered, kind: 'drained', rejected };
    }
    const carrying = firstReport ? records.pending() : undefined;
    firstReport = false;
    // oxlint-disable-next-line no-await-in-loop -- batches go one at a time, oldest first.
    const outcome = await send({
      ...identity,
      ...(carrying === undefined ? {} : { records: carrying.section }),
      samples,
      schemaVersion: REPORT_SCHEMA_VERSION,
      sentAt: Math.trunc(now()),
      transcripts: transcripts(),
    });
    switch (outcome.kind) {
      case 'delivered': {
        carrying?.settle(outcome);
        delivered += samples.length;
        break;
      }
      case 'rejected': {
        carrying?.settle(outcome);
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

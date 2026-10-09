import {
  ChunkAcceptedSchema,
  GenerationOpenedSchema,
  TRANSCRIPT_OFFSET_HEADER,
} from '@heimdall/schema';
import type { OpenGeneration } from '@heimdall/schema';

import { hubEndpoint } from '../delivery.ts';
import { describeError } from '../errors.ts';
import { parseJson } from '../json.ts';

const SEND_TIMEOUT_MS = 30_000;

// How the Hub answered an open (docs/spec.md, "Upload protocol").
export type OpenAnswer =
  | { generation: number; held: number; kind: 'opened' }
  | { kind: 'deleted' }
  | { kind: 'failed'; reason: string };

// How the Hub answered a chunk: `held` when it holds the chunk, `elsewhere`
// when its content ends at another offset, `deleted` for a generation deleted
// on purpose, and `unknown` for one it has no record of.
export type ChunkAnswer =
  | { held: number; kind: 'elsewhere' | 'held' }
  | { kind: 'deleted' | 'unknown' }
  | { kind: 'failed'; reason: string };

// The Hub's transcript endpoints, as the Collector uses them. Tests replace it.
export type TranscriptHub = {
  open: (file: OpenGeneration) => Promise<OpenAnswer>;
  send: (chunk: { body: Uint8Array; generation: number; offset: number }) => Promise<ChunkAnswer>;
};

type Answer = { response: Response } | { reason: string };

// The `held` a 200 or 409 carries, or undefined when the body says otherwise.
const heldIn = async (response: Response) =>
  ChunkAcceptedSchema.safeParse(parseJson(await response.text().catch(() => ''))).data?.held;

// A failure for an answer the protocol does not name.
const failed = async (response: Response) => {
  await response.body?.cancel();
  return { kind: 'failed', reason: `Hub answered ${String(response.status)}` } as const;
};

// The Hub's transcript endpoints at `hub`, authenticated as the System whose
// token is `token`. Every answer other than those the protocol names, an
// unreachable Hub included, fails, so the Collector keeps its spool and retries.
export const transcriptHub = ({
  hub,
  signal,
  token,
}: {
  hub: URL;
  signal?: AbortSignal;
  token: string;
}): TranscriptHub => {
  const post = async (
    path: string,
    init: { body: string | Uint8Array; headers: Record<string, string> },
  ) => {
    const timeout = AbortSignal.timeout(SEND_TIMEOUT_MS);
    try {
      const response = await fetch(hubEndpoint(hub, path), {
        body: init.body,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
        method: 'POST',
        redirect: 'manual',
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      return { response } satisfies Answer;
    } catch (error) {
      return { reason: `Hub unreachable: ${describeError(error)}` } satisfies Answer;
    }
  };

  return {
    open: async (file) => {
      const answer = await post('api/v1/transcripts/generations', {
        body: JSON.stringify(file),
        headers: { 'content-type': 'application/json' },
      });
      if ('reason' in answer) {
        return { kind: 'failed', reason: answer.reason };
      }
      const { response } = answer;
      if (response.status === 201) {
        const opened = GenerationOpenedSchema.safeParse(
          parseJson(await response.text().catch(() => '')),
        );
        return opened.success
          ? { ...opened.data, kind: 'opened' }
          : { kind: 'failed', reason: 'Hub answered 201 without a generation' };
      }
      if (response.status === 410) {
        await response.body?.cancel();
        return { kind: 'deleted' };
      }
      return failed(response);
    },
    send: async ({ body, generation, offset }) => {
      const answer = await post(`api/v1/transcripts/generations/${String(generation)}/chunks`, {
        body,
        headers: {
          'content-type': 'application/gzip',
          [TRANSCRIPT_OFFSET_HEADER]: String(offset),
        },
      });
      if ('reason' in answer) {
        return { kind: 'failed', reason: answer.reason };
      }
      const { response } = answer;
      if (response.status === 200 || response.status === 409) {
        const held = await heldIn(response);
        if (held === undefined) {
          return {
            kind: 'failed',
            reason: `Hub answered ${String(response.status)} without what it holds`,
          };
        }
        return { held, kind: response.status === 200 ? 'held' : 'elsewhere' };
      }
      if (response.status === 410 || response.status === 404) {
        await response.body?.cancel();
        return { kind: response.status === 410 ? 'deleted' : 'unknown' };
      }
      return failed(response);
    },
  };
};

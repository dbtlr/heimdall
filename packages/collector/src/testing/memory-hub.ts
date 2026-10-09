import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';

import type { TranscriptHub } from '../transcripts/hub-client.ts';

type Generation = { content: Buffer; deleted: boolean; path: string; source: string };

const gunzip = promisify(gunzipCallback);
const key = (source: string, path: string) => `${source}/${path}`;

// A Hub that keeps transcripts in memory and answers as docs/spec.md's upload
// protocol says, so capture tests can read back what it holds. `down` makes
// every request fail, as an unreachable Hub does.
export const memoryHub = () => {
  const generations = new Map<number, Generation>();
  const deletedPaths = new Set<string>();
  const opens: string[] = [];
  const sends: { generation: number; offset: number }[] = [];
  let next = 1;
  const state = { down: false };

  const hub: TranscriptHub = {
    open: ({ path, source }) => {
      if (state.down) {
        return Promise.resolve({ kind: 'failed', reason: 'Hub down' });
      }
      opens.push(key(source, path));
      if (deletedPaths.has(key(source, path))) {
        return Promise.resolve({ kind: 'deleted' });
      }
      const generation = next;
      next += 1;
      generations.set(generation, { content: Buffer.alloc(0), deleted: false, path, source });
      return Promise.resolve({ generation, held: 0, kind: 'opened' });
    },
    send: async ({ body, generation, offset }) => {
      if (state.down) {
        return { kind: 'failed', reason: 'Hub down' };
      }
      sends.push({ generation, offset });
      const held = generations.get(generation);
      if (held === undefined) {
        return { kind: 'unknown' };
      }
      if (held.deleted) {
        return { kind: 'deleted' };
      }
      const content = await gunzip(body);
      if (offset === held.content.length) {
        held.content = Buffer.concat([held.content, content]);
        return { held: held.content.length, kind: 'held' };
      }
      if (offset < held.content.length && offset + content.length <= held.content.length) {
        return { held: held.content.length, kind: 'held' };
      }
      return { held: held.content.length, kind: 'elsewhere' };
    },
  };

  const at = (source: string, path: string) =>
    [...generations.entries()].filter(([, g]) => g.source === source && g.path === path);

  return {
    // The content of every live generation at the path, oldest first.
    contents: (source: string, path: string) =>
      at(source, path)
        .filter(([, g]) => !g.deleted)
        .map(([, g]) => g.content.toString('utf8')),
    // Deletes one generation on purpose, leaving the path open.
    deleteGeneration: (generation: number) => {
      const g = generations.get(generation);
      if (g !== undefined) {
        g.deleted = true;
      }
    },
    // Deletes every generation at the path on purpose, as `transcripts delete` does.
    deletePath: (source: string, path: string) => {
      for (const [, g] of at(source, path)) {
        g.deleted = true;
      }
      deletedPaths.add(key(source, path));
    },
    // Forgets every generation, as a Hub whose database was replaced does.
    forgetAll: () => generations.clear(),
    hub,
    opens,
    sends,
    state,
    // Drops the end of a generation's content, as a Hub restored from an older backup does.
    truncate: (generation: number, length: number) => {
      const g = generations.get(generation);
      if (g !== undefined) {
        g.content = g.content.subarray(0, length);
      }
    },
  };
};

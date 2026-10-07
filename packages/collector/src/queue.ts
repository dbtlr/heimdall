import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { VitalsSampleSchema } from '@heimdall/schema';
import type { VitalsSample } from '@heimdall/schema';

import { parseJson } from './json.ts';

// About 24 hours of 15-second samples: what an awake but offline System keeps.
export const QUEUE_CAPACITY = 5760;

// Samples waiting for the Hub, kept on disk so a restart during a Hub outage
// loses nothing. Keyed and read in order of `t`, like the Hub's own store
// (ADR-0004), but trimmed in order of arrival, so a clock that steps back still
// queues new samples.
export type SampleQueue = {
  append: (sample: VitalsSample) => void;
  close: () => void;
  oldest: (limit: number) => VitalsSample[];
  removeThrough: (t: number) => void;
};

type Row = { sample: string; t: number };

export const openQueue = async ({
  capacity,
  stateDir,
}: {
  capacity: number;
  stateDir: string;
}): Promise<SampleQueue> => {
  await mkdir(stateDir, { recursive: true });
  const db = new Database(join(stateDir, 'queue.sqlite'), { create: true, strict: true });
  // Wait out another process's lock instead of failing at once.
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA journal_mode = WAL');
  db.run(
    'CREATE TABLE IF NOT EXISTS samples (arrival INTEGER PRIMARY KEY, t INTEGER NOT NULL UNIQUE, sample TEXT NOT NULL)',
  );

  const insert = db.query('INSERT OR IGNORE INTO samples (t, sample) VALUES ($t, $sample)');
  const trim = db.query(
    'DELETE FROM samples WHERE arrival <= (SELECT max(arrival) FROM samples) - $capacity',
  );
  const select = db.query<Row, { limit: number }>(
    'SELECT t, sample FROM samples ORDER BY t LIMIT $limit',
  );
  const remove = db.query('DELETE FROM samples WHERE t <= $t');
  const discard = db.query('DELETE FROM samples WHERE t = $t');
  const append = db.transaction((sample: VitalsSample) => {
    insert.run({ sample: JSON.stringify(sample), t: sample.t });
    trim.run({ capacity });
  });

  return {
    append,
    close: () => db.close(),
    // A row this build cannot read is discarded rather than left to block delivery.
    oldest: (limit) =>
      select.all({ limit }).flatMap((row) => {
        const parsed = VitalsSampleSchema.safeParse(parseJson(row.sample));
        if (!parsed.success) {
          discard.run({ t: row.t });
          return [];
        }
        return [parsed.data];
      }),
    removeThrough: (t) => {
      remove.run({ t });
    },
  };
};

// How many samples wait in the queue under `stateDir`, for `service status`, or
// undefined when there is no queue yet. It opens the database read-only and
// only reads, so it never creates the queue and, under WAL, never blocks the
// running Collector's writes. SQLite may still create the -wal and -shm files
// beside a queue that has none at that moment.
export const countWaiting = async (stateDir: string): Promise<number | undefined> => {
  const path = join(stateDir, 'queue.sqlite');
  if (!(await Bun.file(path).exists())) {
    return undefined;
  }
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.run('PRAGMA busy_timeout = 1000');
    return db.query<{ n: number }, []>('SELECT count(*) AS n FROM samples').get()?.n ?? 0;
  } finally {
    db.close();
  }
};

import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SPOOL_FILE = 'spool.sqlite';

// What the Collector last saw of a file on disk: its identity, its device and
// inode exactly as `dev:ino`, its size, and its modification time.
export type Fingerprint = { identity: string; mtimeMs: number; size: number };

// What the Collector knows of one file of a source: its fingerprint at the
// last scan and how many scans in a row it was unchanged, the generation its
// content goes to (none until it next spools content), how far it has read,
// and hashes of the first and last bytes it read, to notice them change.
export type FileRecord = Fingerprint & {
  generation: number | null;
  headHash: string | null;
  id: number;
  path: string;
  readOffset: number;
  refused: boolean;
  source: string;
  stableScans: number;
  tailHash: string | null;
};

// A generation with content waiting for the Hub, and the file it belongs to.
export type PendingGeneration = {
  current: boolean;
  file: number;
  hubId: number | null;
  id: number;
  path: string;
  readOffset: number;
  source: string;
};

// One spooled chunk: `length` bytes of the file at `offset`, gzipped into
// `bytes` bytes of body.
export type ChunkHead = { bytes: number; id: number; length: number; offset: number };

export type SpoolSummary = { bytes: number; oldestAt: number | null };

type FileRow = {
  generation: number | null;
  head_hash: string | null;
  id: number;
  identity: string;
  mtime_ms: number;
  path: string;
  read_offset: number;
  refused: number;
  size: number;
  source: string;
  stable_scans: number;
  tail_hash: string | null;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    identity TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    stable_scans INTEGER NOT NULL DEFAULT 0,
    generation INTEGER,
    read_offset INTEGER NOT NULL DEFAULT 0,
    head_hash TEXT,
    tail_hash TEXT,
    refused INTEGER NOT NULL DEFAULT 0,
    UNIQUE (source, path)
  )`,
  `CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY,
    file INTEGER NOT NULL REFERENCES files (id),
    hub_id INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    generation INTEGER NOT NULL REFERENCES generations (id),
    offset INTEGER NOT NULL,
    length INTEGER NOT NULL,
    body BLOB NOT NULL,
    spooled_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS chunks_by_generation ON chunks (generation, offset)',
];

const toRecord = (row: FileRow): FileRecord => ({
  generation: row.generation,
  headHash: row.head_hash,
  id: row.id,
  identity: row.identity,
  mtimeMs: row.mtime_ms,
  path: row.path,
  readOffset: row.read_offset,
  refused: row.refused !== 0,
  size: row.size,
  source: row.source,
  stableScans: row.stable_scans,
  tailHash: row.tail_hash,
});

const SUMMARY_SQL =
  'SELECT coalesce(sum(length(body)), 0) AS bytes, min(spooled_at) AS oldestAt FROM chunks';

// The transcript spool in the state directory (ADR-0013): content read from
// each source's files that the Hub has not acknowledged, and what the
// Collector knows of each file. Content is spooled in the same transaction
// that moves the file's read offset past it, so nothing counts as read before
// it is on disk, and a chunk is removed only once the Hub holds it.
export type Spool = ReturnType<typeof createSpool>;

// A transaction as a plain function, so the spool's type holds no SQLite detail.
const plain =
  <A extends unknown[]>(run: (...args: A) => void) =>
  (...args: A): void => {
    run(...args);
  };

const createSpool = (db: Database) => {
  const fileQuery = db.query<FileRow, { path: string; source: string }>(
    'SELECT * FROM files WHERE source = $source AND path = $path',
  );
  const fileById = db.query<FileRow, { id: number }>('SELECT * FROM files WHERE id = $id');
  const insertFile = db.query<
    { id: number },
    Fingerprint & { path: string; source: string; mtimeMs: number }
  >(
    `INSERT INTO files (source, path, identity, size, mtime_ms)
     VALUES ($source, $path, $identity, $size, $mtimeMs) RETURNING id`,
  );
  const observeFile = db.query(
    `UPDATE files SET identity = $identity, size = $size, mtime_ms = $mtimeMs,
     stable_scans = $stableScans WHERE id = $id`,
  );
  const restartFile = db.query(
    'UPDATE files SET generation = NULL, read_offset = 0, head_hash = NULL, tail_hash = NULL WHERE id = $id',
  );
  const insertGeneration = db.query<{ id: number }, { file: number }>(
    'INSERT INTO generations (file) VALUES ($file) RETURNING id',
  );
  const advanceFile = db.query(
    `UPDATE files SET generation = $generation, read_offset = $readOffset,
     head_hash = $headHash, tail_hash = $tailHash WHERE id = $id`,
  );
  const insertChunk = db.query(
    `INSERT INTO chunks (generation, offset, length, body, spooled_at)
     VALUES ($generation, $offset, $length, $body, $spooledAt)`,
  );
  const pendingQuery = db.query<
    {
      current: number;
      file: number;
      hub_id: number | null;
      id: number;
      path: string;
      read_offset: number;
      source: string;
    },
    []
  >(
    `SELECT g.id, g.hub_id, g.file, f.source, f.path, f.read_offset,
       (f.generation IS g.id) AS current
     FROM generations g JOIN files f ON f.id = g.file
     WHERE EXISTS (SELECT 1 FROM chunks c WHERE c.generation = g.id)
     ORDER BY g.id`,
  );
  const headsQuery = db.query<ChunkHead, { generation: number; limit: number }>(
    `SELECT id, offset, length, length(body) AS bytes FROM chunks
     WHERE generation = $generation ORDER BY offset LIMIT $limit`,
  );
  const bodyQuery = db.query<{ body: Uint8Array }, { id: number }>(
    'SELECT body FROM chunks WHERE id = $id',
  );
  const adoptGeneration = db.query<{ id: number }, { file: number; hubId: number }>(
    'INSERT INTO generations (file, hub_id) VALUES ($file, $hubId) RETURNING id',
  );
  const pointFile = db.query('UPDATE files SET generation = $generation WHERE id = $id');
  const lastChunkEnd = db.query<{ end: number | null }, { generation: number }>(
    'SELECT max(offset + length) AS end FROM chunks WHERE generation = $generation',
  );
  const setHubId = db.query('UPDATE generations SET hub_id = $hubId WHERE id = $id');
  const removeHeld = db.query(
    'DELETE FROM chunks WHERE generation = $generation AND offset + length <= $held',
  );
  const removeChunks = db.query('DELETE FROM chunks WHERE generation = $generation');
  const removeGeneration = db.query('DELETE FROM generations WHERE id = $id');
  const detachFile = db.query(
    'UPDATE files SET generation = NULL, read_offset = 0, head_hash = NULL, tail_hash = NULL WHERE generation = $generation',
  );
  const refuseFile = db.query(
    'UPDATE files SET refused = 1, generation = NULL, read_offset = 0, head_hash = NULL, tail_hash = NULL WHERE id = $id',
  );
  const generationsOf = db.query<{ id: number }, { file: number }>(
    'SELECT id FROM generations WHERE file = $file',
  );
  const settled = db.query(
    `DELETE FROM generations WHERE id = $id
     AND NOT EXISTS (SELECT 1 FROM chunks WHERE generation = $id)
     AND NOT EXISTS (SELECT 1 FROM files WHERE generation = $id)`,
  );
  const summaryQuery = db.query<SpoolSummary, []>(SUMMARY_SQL);

  const dropGeneration = (generation: number) => {
    removeChunks.run({ generation });
    detachFile.run({ generation });
    removeGeneration.run({ id: generation });
  };

  return {
    // Gives a file whose generation the Hub deleted the new generation the Hub
    // just opened at its path, so its content uploads there from the first byte.
    adopt: plain(
      db.transaction((file: number, hubId: number) => {
        const generation = adoptGeneration.get({ file, hubId })?.id ?? null;
        pointFile.run({ generation, id: file });
      }),
    ),
    // Spools `chunks` read from the file, then moves its read offset and
    // hashes past them, in one transaction. The file's first content opens a
    // generation for it.
    append: plain(
      db.transaction(
        (
          id: number,
          {
            chunks,
            headHash,
            readOffset,
            spooledAt,
            tailHash,
          }: {
            chunks: { body: Uint8Array; length: number; offset: number }[];
            headHash: string;
            readOffset: number;
            spooledAt: number;
            tailHash: string;
          },
        ) => {
          const row = fileById.get({ id });
          if (row === null) {
            throw new Error(`no spooled file ${String(id)}`);
          }
          const generation = row.generation ?? insertGeneration.get({ file: id })?.id ?? null;
          for (const chunk of chunks) {
            insertChunk.run({ ...chunk, generation, spooledAt });
          }
          advanceFile.run({ generation, headHash, id, readOffset, tailHash });
        },
      ),
    ),
    // A spooled chunk's gzipped body.
    body: (id: number) => bodyQuery.get({ id })?.body ?? new Uint8Array(),
    // The oldest spooled chunks of `generation`, at most `limit` of them, without their bodies.
    chunks: (generation: number, limit: number) => headsQuery.all({ generation, limit }),
    close: () => db.close(),
    // Drops a generation's spooled content. Its file, if still reading into
    // it, starts over in a new generation at its next scan.
    dropGeneration: plain(db.transaction(dropGeneration)),
    // The end of the content spooled for `generation`, or undefined when none is.
    end: (generation: number) => lastChunkEnd.get({ generation })?.end ?? undefined,
    // What the Collector knows of a file, or undefined for one it has never seen.
    file: (source: string, path: string) => {
      const row = fileQuery.get({ path, source });
      return row === null ? undefined : toRecord(row);
    },
    // Removes the chunks the Hub holds, below `held`, from `generation`.
    held: (generation: number, held: number) => {
      removeHeld.run({ generation, held });
    },
    // Records what a scan saw of a file, creating its record the first time.
    observe: (source: string, path: string, seen: Fingerprint, stableScans: number): FileRecord => {
      const existing = fileQuery.get({ path, source });
      if (existing === null) {
        insertFile.get({ ...seen, path, source });
      } else {
        observeFile.run({ ...seen, id: existing.id, stableScans });
      }
      const row = fileQuery.get({ path, source });
      if (row === null) {
        throw new Error(`no spooled file ${source}/${path}`);
      }
      return toRecord(row);
    },
    // Generations with spooled content, oldest first.
    pending: (): PendingGeneration[] =>
      pendingQuery.all().map((row) => ({
        current: row.current !== 0,
        file: row.file,
        hubId: row.hub_id,
        id: row.id,
        path: row.path,
        readOffset: row.read_offset,
        source: row.source,
      })),
    // Stops a path the Hub refused as deleted on purpose, dropping everything
    // spooled for it.
    refuse: plain(
      db.transaction((file: number) => {
        for (const { id } of generationsOf.all({ file })) {
          dropGeneration(id);
        }
        refuseFile.run({ id: file });
      }),
    ),
    // Starts the file over: its next content opens a new generation from its
    // first byte. Its old generation's spooled content still goes to the Hub.
    restart: plain(
      db.transaction((file: number) => {
        const generation = fileById.get({ id: file })?.generation ?? null;
        restartFile.run({ id: file });
        if (generation !== null) {
          settled.run({ id: generation });
        }
      }),
    ),
    // Records the Hub's identifier for a generation, or forgets it.
    setHubId: (generation: number, hubId: number | null) => {
      setHubId.run({ hubId, id: generation });
    },
    // Forgets a generation that holds no content and that no file reads into.
    settle: (generation: number) => {
      settled.run({ id: generation });
    },
    // The bytes spooled and when the oldest of them was.
    summary: (): SpoolSummary => summaryQuery.get() ?? { bytes: 0, oldestAt: null },
  };
};

// Opens the spool under `stateDir`, creating it the first time.
export const openSpool = async ({ stateDir }: { stateDir: string }): Promise<Spool> => {
  await mkdir(stateDir, { recursive: true });
  const db = new Database(join(stateDir, SPOOL_FILE), { create: true, strict: true });
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA journal_mode = WAL');
  for (const statement of SCHEMA) {
    db.run(statement);
  }
  return createSpool(db);
};

// The spool's size and the age of its oldest content, for `service status`,
// or undefined when there is no spool yet. It opens the database read-only, as
// `countWaiting` does the queue, so it never creates it or blocks the Collector.
export const readSpoolSummary = async (stateDir: string): Promise<SpoolSummary | undefined> => {
  const path = join(stateDir, SPOOL_FILE);
  if (!(await Bun.file(path).exists())) {
    return undefined;
  }
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.run('PRAGMA busy_timeout = 1000');
    return db.query<SpoolSummary, []>(SUMMARY_SQL).get() ?? { bytes: 0, oldestAt: null };
  } finally {
    db.close();
  }
};

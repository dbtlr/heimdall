import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

type Lifetime = { bootId: string; pid: number; start: string };
export type ProcessName = Lifetime &
  ({ kind: 'fallback'; label: string } | { kind: 'confirmed'; label: string; executable: string });

export type ProcessNameStore = {
  close: () => void;
  forget: (lifetime: Lifetime) => void;
  list: () => ProcessName[];
  save: (name: ProcessName) => void;
};

export const processNameKey = ({ bootId, pid, start }: Lifetime): string =>
  JSON.stringify([bootId, pid, start]);

export const memoryProcessNames = (): ProcessNameStore => {
  const names = new Map<string, ProcessName>();
  return {
    close: () => {},
    forget: (lifetime) => {
      names.delete(processNameKey(lifetime));
    },
    list: () => [...names.values()],
    save: (name) => {
      names.set(processNameKey(name), name);
    },
  };
};

type Row = Lifetime & { label: string; executable: string | null };

const fromRow = ({ executable, ...name }: Row): ProcessName =>
  executable === null ? { ...name, kind: 'fallback' } : { ...name, executable, kind: 'confirmed' };

// Labels are lifetime facts. Persist them separately from CPU baselines so a
// restart cannot interpret a mutable accounting name as an executable change.
export const openProcessNames = async ({
  stateDir,
}: {
  stateDir: string;
}): Promise<ProcessNameStore> => {
  await mkdir(stateDir, { recursive: true });
  const db = new Database(join(stateDir, 'process-names.sqlite'), { create: true, strict: true });
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA journal_mode = WAL');
  db.run(
    'CREATE TABLE IF NOT EXISTS process_names (boot_id TEXT NOT NULL, pid INTEGER NOT NULL, start TEXT NOT NULL, label TEXT NOT NULL, executable TEXT, PRIMARY KEY (boot_id, pid, start))',
  );
  const select = db.query<Row, []>(
    'SELECT boot_id AS bootId, pid, start, label, executable FROM process_names',
  );
  const save = db.query(
    'INSERT INTO process_names (boot_id, pid, start, label, executable) VALUES ($bootId, $pid, $start, $label, $executable) ON CONFLICT (boot_id, pid, start) DO UPDATE SET label = excluded.label, executable = excluded.executable WHERE process_names.label IS NOT excluded.label OR process_names.executable IS NOT excluded.executable',
  );
  const forget = db.query(
    'DELETE FROM process_names WHERE boot_id = $bootId AND pid = $pid AND start = $start',
  );
  return {
    close: () => db.close(),
    forget: ({ bootId, pid, start }) => {
      forget.run({ bootId, pid, start });
    },
    list: () => select.all().map(fromRow),
    save: (name) => {
      save.run({
        bootId: name.bootId,
        executable: name.kind === 'confirmed' ? name.executable : null,
        label: name.label,
        pid: name.pid,
        start: name.start,
      });
    },
  };
};

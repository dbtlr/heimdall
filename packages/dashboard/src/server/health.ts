import type { SQL } from 'bun';

// How long `GET /api/health` waits for the database, as the Hub's does.
const HEALTH_TIMEOUT_MS = 2000;

// `GET /api/health`: 200 when the Hub's database answers a trivial query within
// the timeout, 503 when it does not or cannot be opened. The body has the
// Hub's shape, so `service status` and a provisioner's health check read both
// alike.
export const healthAnswer = async ({
  database,
  timeoutMs = HEALTH_TIMEOUT_MS,
  version,
}: {
  database: () => Promise<SQL>;
  timeoutMs?: number;
  version: string;
}): Promise<Response> => {
  const answered = await Promise.race([
    database()
      .then((sql) => sql`SELECT 1`)
      .then(
        () => true,
        () => false,
      ),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
  return Response.json(
    { database: answered ? 'ok' : 'not answering', version },
    { status: answered ? 200 : 503 },
  );
};

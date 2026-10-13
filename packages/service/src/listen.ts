// The server listening on `hostname`:`port`, or `fail` with a message that
// names the address, such as a port another process holds, rather than a bare
// exception that a release build shows as a generic message.
export const listenOrFail = ({
  fail,
  fetch,
  hostname,
  idleTimeout = 10,
  port,
}: {
  fail: (message: string) => never;
  fetch: (request: Request) => Promise<Response>;
  hostname: string;
  idleTimeout?: number;
  port: number;
}) => {
  try {
    return Bun.serve({ fetch, hostname, idleTimeout, port });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return fail(`Could not listen on ${hostname}:${String(port)}: ${cause}`);
  }
};

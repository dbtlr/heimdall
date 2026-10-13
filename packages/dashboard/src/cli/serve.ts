import { once } from 'node:events';

import { homeOf, keepLogRotated, listenOrFail, runtimeLog, servicePaths } from '@heimdall/service';
import type { RuntimeLog } from '@heimdall/service';
import { Command, escapeControlCharacters } from '@loomcli/core';
import { configInput } from '@loomcli/plugins/config/extension';
import { integer, text } from '@loomcli/validators';

// The app Vite built: one handler that renders the pages, answers the server
// functions and API routes, and serves the static assets.
export type BuiltServer = { fetch: (request: Request) => Promise<Response> | Response };

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// The built app's handler, with a warning logged for each request it answers
// with a server error, so a failing page leaves a line in the log. The page
// itself shows the cause. A failed health check is left out, as the Hub leaves
// it out, so an outage does not log on every poll.
const answeringWith =
  (app: BuiltServer, log: RuntimeLog, clean: (message: string) => string) =>
  async (request: Request): Promise<Response> => {
    const response = await app.fetch(request);
    const { pathname } = new URL(request.url);
    if (response.status >= 500 && pathname !== '/api/health') {
      await log.warn(clean(`${request.method} ${pathname} answered ${String(response.status)}.`));
    }
    return response;
  };

// `heimdall-dashboard serve`: serves the built app until systemd or a terminal
// stops it. Each setting comes from its flag, then its variable, then
// dashboard.toml. The database URL is not one of them: the app reads the Hub's
// own, from hub.toml, on its first request. Its runtime lines start with their
// time, and it rotates its supervised log before its first line, then about
// once a day.
export const serveCommand = (loadServer: () => Promise<BuiltServer>) =>
  new Command('serve', { description: "Serve the dashboard from the Hub's database." })
    .option('host', {
      default: '127.0.0.1',
      description: 'Address to listen on.',
      env: 'HEIMDALL_DASHBOARD_HOST',
      extensions: [configInput({ path: 'host' })],
      type: 'string',
      validate: text({ minLength: 1 }),
    })
    .option('port', {
      default: '3000',
      description: 'TCP port to listen on; 0 picks a free one.',
      env: 'HEIMDALL_DASHBOARD_PORT',
      extensions: [configInput({ path: 'port' })],
      type: 'string',
      validate: integer({ max: 65_535, min: 0 }),
    })
    .action(async ({ host, options, out, signal, style }) => {
      const clean = (message: string) => style.escape(escapeControlCharacters(message));
      const log = runtimeLog({
        fatal: (line) => out.fatal(line),
        print: (line) => out.print(line),
      });
      const stopRotating = await keepLogRotated({
        onError: (error) => {
          void log.warn(clean(`Could not rotate the log: ${describeError(error)}`));
        },
        path: servicePaths('dashboard', homeOf(host.env)).log,
      });
      try {
        const app = await loadServer().catch((error: unknown) =>
          log.fatal(
            clean(
              `Could not load the built dashboard (${describeError(error)}). If it is missing, build it with bun run --cwd packages/dashboard build.`,
            ),
          ),
        );
        const server = listenOrFail({
          fail: (message) => log.fatal(clean(message)),
          fetch: answeringWith(app, log, clean),
          hostname: options.host,
          // Page queries allow 30 seconds before they time out, then rendering
          // still has to send the response instead of losing the connection.
          idleTimeout: 60,
          port: options.port,
        });
        try {
          await log.info(clean(`Listening on ${server.url.href}.`));
          if (!signal.aborted) {
            await once(signal, 'abort');
          }
        } finally {
          await server.stop();
        }
      } finally {
        await stopRotating();
      }
    });

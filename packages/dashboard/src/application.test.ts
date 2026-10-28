import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';
import { assertAssembles, mockProcess } from '@loomcli/testing';

import packageJson from '../package.json' with { type: 'json' };
import { createApp } from './application.ts';
import type { BuiltServer } from './application.ts';

const LISTENING = /Listening on (?<url>http:\/\/\S+)/u;

// A built app that answers every request with its path.
const echo: BuiltServer = {
  fetch: (request) => new Response(`served ${new URL(request.url).pathname}`),
};

// Runs the dashboard command line in-process with `home` as HOME and captures
// what it prints. Once `serve` logs its address, `whileServing` runs against it
// and the run is cancelled; a safety timeout cancels it anyway.
const invoke = async (
  argv: string[],
  {
    home,
    idleTimeout,
    loadServer = () => Promise.resolve(echo),
    whileServing,
  }: {
    home: string;
    idleTimeout?: number;
    loadServer?: () => Promise<BuiltServer>;
    whileServing?: (url: URL) => Promise<void>;
  },
) => {
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 35_000);
  const mock = mockProcess({ argv, cwd: home, env: { HOME: home } });
  let serving: Promise<void> | undefined;
  // The mock records output without events, so poll it for the address.
  const watch = setInterval(() => {
    const url = LISTENING.exec(mock.stdout.text)?.groups?.url;
    if (url !== undefined && serving === undefined) {
      serving = (async () => {
        try {
          await whileServing?.(new URL(url));
        } finally {
          controller.abort();
        }
      })();
    }
  }, 10);
  try {
    const code = await createApp({ idleTimeout, loadServer }).run({
      process: mock,
      signal: controller.signal,
    });
    await serving;
    return { code, stderr: mock.stderr.text, stdout: mock.stdout.text };
  } finally {
    clearInterval(watch);
    clearTimeout(safety);
  }
};

const withHome = async (work: (home: string) => Promise<void>) => {
  const home = await mkdtemp(join(tmpdir(), 'heimdall-dashboard-home-'));
  try {
    await work(home);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
};

// A port nothing listens on right now.
const freePort = async () => {
  const probe = Bun.serve({ fetch: () => new Response(), hostname: '127.0.0.1', port: 0 });
  const { port } = probe;
  await probe.stop();
  return port;
};

test('the application assembles', () => {
  assertAssembles(createApp({ loadServer: () => Promise.resolve(echo) }));
});

test('--version names the dashboard release in the form every Heimdall binary prints', async () => {
  await withHome(async (home) => {
    const { code, stdout } = await invoke(['--version'], { home });

    expect(stdout).toBe(
      `heimdall-dashboard v${packageJson.version} (Report schema v${REPORT_SCHEMA_VERSION})\n`,
    );
    expect(code).toBe(0);
  });
});

test('serve listens on the port in dashboard.toml and answers with the built app', async () => {
  await withHome(async (home) => {
    const port = await freePort();
    await mkdir(join(home, '.config', 'heimdall'), { recursive: true });
    await writeFile(
      join(home, '.config', 'heimdall', 'dashboard.toml'),
      `port = ${String(port)}\n`,
    );
    let body = '';

    const { code, stdout } = await invoke(['serve'], {
      home,
      whileServing: async (url) => {
        body = await (await fetch(new URL('/systems/laptop-1', url))).text();
      },
    });

    expect(stdout).toMatch(
      new RegExp(
        `^\\d{4}-\\d\\d-\\d\\dT\\S+Z Listening on http://127\\.0\\.0\\.1:${String(port)}/`,
        'mu',
      ),
    );
    expect(body).toBe('served /systems/laptop-1');
    // Cancelled, as a signal would.
    expect(code).toBe(130);
  });
});

// Bun checks idle sockets about every 4 seconds, so a 1 second timeout cuts a
// request that has waited 6 seconds off after about 4.
test('serve gives the server its idle timeout, which cuts off a request slower than it', async () => {
  await withHome(async (home) => {
    let body: string | undefined;
    let failure: string | undefined;
    const slow: BuiltServer = {
      fetch: async () => {
        await Bun.sleep(6000);
        return new Response('served slow overview');
      },
    };

    const { code } = await invoke(['serve', '--port', '0'], {
      home,
      idleTimeout: 1,
      loadServer: () => Promise.resolve(slow),
      whileServing: async (url) => {
        try {
          body = await (await fetch(url, { signal: AbortSignal.timeout(30_000) })).text();
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      },
    });

    expect(body).toBeUndefined();
    expect(failure).toContain('socket connection was closed');
    expect(code).toBe(130);
  });
}, 15_000);

test('serve without a built app says how to build it, and exits 1', async () => {
  await withHome(async (home) => {
    const { code, stderr } = await invoke(['serve', '--port', '0'], {
      home,
      loadServer: () => Promise.reject(new Error('Cannot find module')),
    });

    expect(stderr).toContain('Could not load the built dashboard (Cannot find module)');
    expect(stderr).toContain('bun run --cwd packages/dashboard build');
    expect(code).toBe(1);
  });
});

test('serve logs a warning for a request it answers with a server error, but not for health', async () => {
  await withHome(async (home) => {
    const failing: BuiltServer = {
      fetch: () => new Response('Error', { status: 500 }),
    };

    const { stdout } = await invoke(['serve', '--port', '0'], {
      home,
      loadServer: () => Promise.resolve(failing),
      whileServing: async (url) => {
        await fetch(new URL('/systems/laptop-1?range=24h', url));
        await fetch(new URL('/api/health', url));
      },
    });

    expect(stdout).toMatch(/^\S+Z warning: GET \/systems\/laptop-1 answered 500\.$/mu);
    expect(stdout).not.toContain('/api/health');
  });
});

test('serve on a port already in use says which address it could not listen on, and exits 1', async () => {
  await withHome(async (home) => {
    const taken = Bun.serve({ fetch: () => new Response(), hostname: '127.0.0.1', port: 0 });
    try {
      const { code, stderr } = await invoke(['serve', '--port', String(taken.port)], { home });

      expect(stderr).toMatch(
        new RegExp(`\\S+Z Could not listen on 127\\.0\\.0\\.1:${String(taken.port)}: \\S`, 'u'),
      );
      expect(code).toBe(1);
    } finally {
      await taken.stop();
    }
  });
});

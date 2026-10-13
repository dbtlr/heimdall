import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';

import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';

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
    loadServer = () => Promise.resolve(echo),
    whileServing,
  }: {
    home: string;
    loadServer?: () => Promise<BuiltServer>;
    whileServing?: (url: URL) => Promise<void>;
  },
) => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 5000);
  let logged = '';
  let serving: Promise<void> | undefined;
  stdout.on('data', (chunk: Buffer) => {
    logged += chunk.toString();
    const url = LISTENING.exec(logged)?.groups?.url;
    if (url !== undefined && serving === undefined) {
      serving = (async () => {
        try {
          await whileServing?.(new URL(url));
        } finally {
          controller.abort();
        }
      })();
    }
  });
  const errors = text(stderr);
  // Loom sets process.exitCode even for an injected host; keep it off the test runner.
  const runnerExitCode = process.exitCode;
  let code: number;
  try {
    code = await createApp({ loadServer }).run({
      host: { argv, cwd: home, env: { HOME: home }, stderr, stdout },
      signal: controller.signal,
    });
    await serving;
  } finally {
    process.exitCode = runnerExitCode ?? 0;
    clearTimeout(safety);
  }
  stdout.end();
  stderr.end();
  return { code, stderr: await errors, stdout: logged };
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

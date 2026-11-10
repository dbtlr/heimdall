import { expect } from 'bun:test';

// A test helper: the Chromium executable DOM tests run in, or null when none
// is set or on PATH, so those tests skip.
export const testBrowser =
  process.env.HEIMDALL_TEST_BROWSER ?? Bun.which('chromium') ?? Bun.which('google-chrome');

// Room for a first Chromium launch from a cold disk (HMD-192). A warm launch takes about a second.
export const BROWSER_TEST_TIMEOUT_MS = 60_000;

// Bundles `entry`, a script that ends by writing `passed` into the page body or
// else the failure, serves it, and loads it in headless Chromium; fails the
// test unless the page reports `passed`.
export const runInBrowser = async (browser: string, entry: URL, passed: string) => {
  const bundle = await Bun.build({
    define: { 'process.env.NODE_ENV': '"development"' },
    entrypoints: [entry.pathname],
    target: 'browser',
  });
  expect(bundle.success).toBe(true);
  const script = bundle.outputs[0];
  if (script === undefined) {
    throw new Error('Browser test bundle is missing.');
  }
  const server = Bun.serve({
    fetch: (request) =>
      new URL(request.url).pathname === '/test.js'
        ? new Response(script, { headers: { 'content-type': 'text/javascript' } })
        : new Response('<!doctype html><script type="module" src="/test.js"></script>', {
            headers: { 'content-type': 'text/html' },
          }),
    hostname: '127.0.0.1',
    port: 0,
  });
  const process = Bun.spawn(
    [
      browser,
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--dump-dom',
      '--virtual-time-budget=10000',
      server.url.href,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  try {
    const [output, errors, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect({ code, output }).toEqual({ code: 0, output: expect.stringContaining(passed) });
    expect(errors).not.toContain('Uncaught');
  } finally {
    process.kill();
    await server.stop(true);
  }
};

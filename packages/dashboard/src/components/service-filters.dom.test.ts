import { expect, test } from 'bun:test';

const browser =
  process.env.HEIMDALL_TEST_BROWSER ?? Bun.which('chromium') ?? Bun.which('google-chrome');

test.skipIf(browser === null)(
  'Service filter sheet drafts, dismissals, apply, reopening, and URL clearing in the DOM',
  async () => {
    if (browser === null) {
      throw new Error('Set HEIMDALL_TEST_BROWSER to a Chromium executable.');
    }
    const bundle = await Bun.build({
      define: { 'process.env.NODE_ENV': '"development"' },
      entrypoints: [new URL('service-filters.browser.tsx', import.meta.url).pathname],
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
      expect({ code, output }).toEqual({
        code: 0,
        output: expect.stringContaining('Service filter DOM tests passed'),
      });
      expect(errors).not.toContain('Uncaught');
    } finally {
      process.kill();
      await server.stop(true);
    }
  },
  30_000,
);

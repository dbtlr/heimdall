import { expect, test } from 'bun:test';

import { renderRouted } from './render-routed.tsx';
import { InstalledLine, UpdateLines } from './service-installed.tsx';

test('says the installed version with its upstream', async () => {
  const html = await renderRouted(
    <InstalledLine
      installed={{ missingApplication: undefined, upstream: 'apt:web', version: '1.2' }}
    />,
  );
  expect(html).toContain('Installed 1.2 · apt:web');
});

test('says the version is unknown', async () => {
  const html = await renderRouted(
    <InstalledLine installed={{ missingApplication: undefined, upstream: null, version: null }} />,
  );
  expect(html).toContain('Installed version unknown<');
});

test('says which Application the Service names when it is not recorded', async () => {
  const html = await renderRouted(
    <InstalledLine installed={{ missingApplication: 'web', upstream: null, version: null }} />,
  );
  expect(html).toContain(
    'Installed version unknown · names Application web, which is not recorded',
  );
});

test('names a missing Application beside a Docker image tag', async () => {
  const html = await renderRouted(
    <InstalledLine installed={{ missingApplication: 'web', upstream: null, version: '1.27' }} />,
  );
  expect(html).toContain('Installed 1.27 · names Application web, which is not recorded');
});

test('an update names its version and dates when it became available', async () => {
  const html = await renderRouted(
    <UpdateLines
      now={2000}
      update={{
        failure: undefined,
        status: { kind: 'update', since: 1000, source: 'upstream', version: '2.0' },
      }}
    />,
  );
  expect(html).toContain('Update 2.0');
  expect(html).toContain(' · available since ');
  expect(html).toContain('dateTime="1970-01-01T00:00:01.000Z"');
});

test('an undated update omits the since phrase', async () => {
  const html = await renderRouted(
    <UpdateLines
      now={2000}
      update={{
        failure: undefined,
        status: { kind: 'update', since: undefined, source: 'upstream', version: '2.0' },
      }}
    />,
  );
  expect(html).toContain('Update 2.0');
  expect(html).not.toContain('available since');
});

for (const source of ['APT', 'Homebrew'] as const) {
  test(`${source} attributes the update to its check`, async () => {
    const html = await renderRouted(
      <UpdateLines
        now={2000}
        update={{ failure: undefined, status: { kind: 'update', source, version: '2.0' } }}
      />,
    );
    expect(html).toContain(`Update 2.0 · from the ${source} check`);
    expect(html).not.toContain('available since');
  });
}

test('a current version, an unreadable version, and unknown knowledge have distinct copy', async () => {
  expect(
    await renderRouted(
      <UpdateLines now={2000} update={{ failure: undefined, status: { kind: 'current' } }} />,
    ),
  ).toContain('Up to date');
  expect(
    await renderRouted(
      <UpdateLines
        now={2000}
        update={{ failure: undefined, status: { kind: 'unreadable', version: 'latest' } }}
      />,
    ),
  ).toContain('Version latest can&#x27;t be compared');
  expect(
    await renderRouted(
      <UpdateLines now={2000} update={{ failure: undefined, status: undefined }} />,
    ),
  ).toBe('');
});

// The Hub's reasons usually end a sentence already; the line adds a period only when one does not.
for (const [succeededAt, reason] of [
  [null, 'Rate limited'],
  [1000, 'Rate limited.'],
] as const) {
  test(`a failed check states its failure time and last success in one paragraph ${String(succeededAt)}`, async () => {
    const html = await renderRouted(
      <UpdateLines
        now={3000}
        update={{
          failure: { at: 2000, reason, succeededAt },
          status: succeededAt === null ? undefined : { kind: 'current' },
        }}
      />,
    );
    expect(html).not.toContain('npm:web');
    expect(html).not.toContain('<span');
    expect(html).toContain('Last check failed ');
    expect(html).toContain('dateTime="1970-01-01T00:00:02.000Z"');
    const text = html.replace(/<time\b[^>]*>.*?<\/time>/gu, '[time]').replace(/<[^>]+>/gu, '');
    expect(text).toBe(
      succeededAt === null
        ? 'Last check failed [time]: Rate limited. It has never succeeded.'
        : 'Up to dateLast check failed [time]: Rate limited. Last succeeded [time].',
    );
    if (succeededAt !== null) {
      expect(html).toContain('dateTime="1970-01-01T00:00:01.000Z"');
    }
  });
}

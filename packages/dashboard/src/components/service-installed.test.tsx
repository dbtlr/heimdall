import { expect, test } from 'bun:test';

import { renderRouted } from './render-routed.tsx';
import { InstalledLine } from './service-installed.tsx';

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

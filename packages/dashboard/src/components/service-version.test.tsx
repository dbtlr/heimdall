import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { ServiceVersion } from './service-version.tsx';

test('a long version and update wrap inside a narrow card instead of running past it', () => {
  const digest = 'sha256-0123456789abcdef0123456789abcdef01234567';
  const html = renderToStaticMarkup(
    <ServiceVersion service={{ update: `${digest}-next`, version: digest }} />,
  );
  const [outer = ''] = /<span class="[^"]*"/u.exec(html) ?? [];
  expect(outer).toContain('min-w-0');
  expect(outer).toContain('flex-wrap');
  expect(outer).not.toContain('flex-none');
  expect(html.match(/wrap-anywhere/gu)?.length).toBe(2);
});

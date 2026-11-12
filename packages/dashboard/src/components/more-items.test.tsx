import { expect, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { MoreItems } from './more-items.tsx';

test('an expanded long list scrolls within its disclosure unless told to grow', () => {
  const html = renderToStaticMarkup(
    <MoreItems label="12 more">
      <p>item</p>
    </MoreItems>,
  );

  expect(html).toMatch(/<\/summary><div class="[^"]*max-h-\[50dvh\] overflow-y-auto/u);
});

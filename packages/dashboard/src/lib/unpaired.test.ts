import { describe, expect, test } from 'bun:test';

import { emptyFleetText, unpairedFromSearch, unpairedLinkText } from './unpaired.ts';

describe('unpairedFromSearch', () => {
  test.each([
    [{ unpaired: '' }, true],
    [{ unpaired: true }, true],
    [{ unpaired: 'anything' }, true],
    [{ unpaired: false }, false],
    [{ unpaired: 'false' }, false],
    [{}, false],
  ])('reads %p as %p', (search, shown) => {
    expect(unpairedFromSearch(search)).toBe(shown);
  });
});

describe('unpairedLinkText', () => {
  test('offers to show the unpaired Systems, counted, singular or plural', () => {
    expect(unpairedLinkText(1, false)).toBe('Show 1 unpaired System');
    expect(unpairedLinkText(2, false)).toBe('Show 2 unpaired Systems');
  });

  test('offers to hide them once shown', () => {
    expect(unpairedLinkText(1, true)).toBe('Hide 1 unpaired System');
    expect(unpairedLinkText(3, true)).toBe('Hide 3 unpaired Systems');
  });
});

test('the link leads back when shown with no unpaired System to list', () => {
  expect(unpairedLinkText(0, true)).toBe('Back to Fleet');
});

describe('emptyFleetText', () => {
  test('says no System is paired when there are no lanes', () => {
    expect(emptyFleetText([])).toBe('No System is paired.');
  });

  test('says no System has reported yet when every paired System has never been seen', () => {
    expect(emptyFleetText([{ lastSeenAt: undefined }, { lastSeenAt: undefined }])).toBe(
      'No System has reported yet.',
    );
  });

  test('says nothing once any paired System has reported', () => {
    expect(emptyFleetText([{ lastSeenAt: undefined }, { lastSeenAt: 5 }])).toBeUndefined();
  });
});

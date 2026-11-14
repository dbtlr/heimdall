import { expect, test } from 'bun:test';

import { trackPointer } from './activity-axis.tsx';

// A lane track 100 px wide whose time is its x in minutes.
const setup = () => {
  const drags: (number | undefined)[] = [];
  const pins: number[] = [];
  const pointer = trackPointer({
    at: ({ clientX }) => clientX,
    onDrag: (at) => drags.push(at),
    onPin: (at) => pins.push(at),
  });
  const down = (clientX: number) => {
    pointer.onPointerDown({
      clientX,
      currentTarget: { setPointerCapture: () => {} },
      pointerId: 1,
    });
  };
  return { down, drags, pins, pointer };
};

test('a drag shows its line under the pointer and pins where it is released', () => {
  const { down, drags, pins, pointer } = setup();
  down(10);
  pointer.onPointerMove({ clientX: 20 });
  pointer.onPointerUp({ clientX: 30 });
  expect(drags).toEqual([10, 20, undefined]);
  expect(pins).toEqual([30]);
});

test('a pointer the browser takes back for a scroll ends the drag with no line and no pin', () => {
  const { down, drags, pins, pointer } = setup();
  down(10);
  pointer.onPointerCancel();
  // A move after it, as the page scrolls, draws nothing.
  pointer.onPointerMove({ clientX: 40 });
  pointer.onPointerUp({ clientX: 40 });
  expect(drags).toEqual([10, undefined]);
  expect(pins).toEqual([]);
});

// The content frame every page shares: centered, with side padding. Below `lg`
// each width and padding is what the page always had; from `lg` up all pages,
// headers included, share one width and padding, as the sidebar leaves the
// room. Class names are written whole so Tailwind finds them.
const FRAME_WIDTH = {
  narrow: 'max-w-[720px] lg:max-w-[1400px]',
  wide: 'max-w-[1200px] lg:max-w-[1400px]',
} as const;

export type FrameWidth = keyof typeof FRAME_WIDTH;

// `phonePaddingOnly` keeps the 14px side padding at every width below `lg`, for
// the one page that never widened it.
export const contentFrame = (width: FrameWidth, phonePaddingOnly = false): string =>
  `mx-auto ${FRAME_WIDTH[width]} px-3.5 ${phonePaddingOnly ? '' : 'sm:px-[22px] '}lg:px-8`;

// Tailwind's `lg` breakpoint as a media query: from here the sidebar shows.
export const WIDE_MEDIA = '(min-width: 1024px)';

// Whether this runs in a browser narrower than `lg`, where the wide-screen
// layout is hidden and its data need not be read. False on the server, which
// cannot tell a phone from a desktop.
export const isNarrowBrowser = (): boolean =>
  typeof globalThis.matchMedia === 'function' && !globalThis.matchMedia(WIDE_MEDIA).matches;

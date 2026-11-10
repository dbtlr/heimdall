// The content frame every page shares: centered, with side padding. Below `lg`
// each width and padding is what the page always had; from `lg` up all pages,
// the top bar included, fill the window's width inside 14px gutters. Class
// names are written whole so Tailwind finds them.
const FRAME_WIDTH = {
  narrow: 'max-w-[720px] lg:max-w-none',
  wide: 'max-w-[1200px] lg:max-w-none',
} as const;

export type FrameWidth = keyof typeof FRAME_WIDTH;

// `phonePaddingOnly` keeps the 14px side padding at every width, for the one
// page that never widened it.
export const contentFrame = (width: FrameWidth, phonePaddingOnly = false): string =>
  `mx-auto ${FRAME_WIDTH[width]} px-3.5 ${phonePaddingOnly ? '' : 'sm:px-[22px] lg:px-3.5'}`.trimEnd();

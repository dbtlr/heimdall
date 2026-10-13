// Whether the overview shows the unpaired Systems, kept in the URL as the
// `unpaired` search parameter so a link shares it and a refresh keeps it.

// Whether a URL's search asks for the unpaired Systems: any value but false,
// so a bare `?unpaired` counts.
export const unpairedFromSearch = (search: Record<string, unknown>): boolean =>
  search.unpaired !== undefined && search.unpaired !== false && search.unpaired !== 'false';

// The link that shows or hides the unpaired Systems: "Show 2 unpaired Systems".
// Shown with none to list, as a URL can ask, it leads back instead.
export const unpairedLinkText = (count: number, shown: boolean): string => {
  if (shown && count === 0) {
    return 'Back to Fleet';
  }
  return `${shown ? 'Hide' : 'Show'} ${String(count)} unpaired System${count === 1 ? '' : 's'}`;
};

// What the overview says when there is little to draw: that no System is
// paired, in place of the lanes, or that paired Systems have yet to send a
// first Report, above their Never seen lanes so the names stay in view.
// Undefined when any lane has been heard from.
export const emptyFleetText = (
  lanes: readonly { lastSeenAt: number | undefined }[],
): { replacesLanes: boolean; text: string } | undefined => {
  if (lanes.length === 0) {
    return { replacesLanes: true, text: 'No System is paired.' };
  }
  return lanes.every(({ lastSeenAt }) => lastSeenAt === undefined)
    ? { replacesLanes: false, text: 'No System has reported yet.' }
    : undefined;
};

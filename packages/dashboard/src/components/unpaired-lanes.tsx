import { Link } from '@tanstack/react-router';

import { unpairedLinkText } from '../lib/unpaired.ts';

const LINK = 'text-link underline decoration-link/45 underline-offset-[3px]';

// The link below the Systems that shows the unpaired Systems or, once shown, hides
// them. The choice lives in the URL as `unpaired`. Nothing without a count, and
// no way back when nothing is shown.
export function UnpairedLink({ count, shown }: { count: number; shown: boolean }) {
  if (count === 0 && !shown) {
    return null;
  }
  return (
    <p className="border-t pt-2 pb-1">
      <Link
        className={LINK}
        resetScroll={false}
        search={(previous) => ({ ...previous, unpaired: shown ? undefined : true })}
        to={shown && count === 0 ? '/' : '.'}
      >
        {unpairedLinkText(count, shown)}
      </Link>
    </p>
  );
}

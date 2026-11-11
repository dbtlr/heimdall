import { Link } from '@tanstack/react-router';

// Across the top of an unpaired System's page: what that means, and the way back.
export function UnpairedBanner({ name }: { name: string }) {
  return (
    <div className="mb-2 card-surface rounded-xl border border-dashed border-dim px-3.5 py-2.5">
      <b className="font-semibold">{name} is unpaired.</b> Its history is kept, no new Reports
      arrive, and its open Conditions stay as they were.{' '}
      <Link
        className="ml-1.5 text-link underline decoration-link/45 underline-offset-[3px]"
        search={{ unpaired: true }}
        to="/"
      >
        Back to Home
      </Link>
    </div>
  );
}

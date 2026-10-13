import { Link } from '@tanstack/react-router';

// Across the top of an unpaired System's page: what the page is, and the way back.
export function UnpairedBanner({ name }: { name: string }) {
  return (
    <div className="mb-2 rounded-lg border border-dashed border-[#5a6690] bg-card px-3.5 py-2.5">
      <b className="font-semibold">{name} is unpaired.</b> Its history is kept and this page is
      read-only: no new Reports arrive, and its open Conditions stay as they were.{' '}
      <Link
        className="ml-1.5 text-[#4a90ea] underline decoration-[#4a90ea]/45 underline-offset-[3px]"
        search={{ unpaired: true }}
        to="/"
      >
        Back to Fleet
      </Link>
    </div>
  );
}

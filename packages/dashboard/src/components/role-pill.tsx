import { seatText } from '../lib/cost-roles.ts';
import { cn } from '../lib/utils.ts';

// A conversation's role as a pill: the role, and for a review its seat in a
// quieter weight, "seat unknown" when the tag named none. A long role wraps
// inside the pill rather than pushing past the page.
export function RolePill({
  className,
  role,
  seat,
}: {
  className?: string;
  role: string;
  seat: string | undefined;
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full flex-wrap items-center gap-x-1.5 rounded-[14px] border bg-secondary px-2.5 text-[14px] leading-normal font-medium wrap-anywhere',
        className,
      )}
    >
      <span>{role}</span>
      {role === 'review' && (
        <span className="font-normal text-muted-foreground">{seatText(seat)}</span>
      )}
    </span>
  );
}

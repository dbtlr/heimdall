import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { anchorOf } from '../lib/attention.ts';
import type { Attention } from '../server/attention-types.ts';

// A link to an open item: its Condition's page, or for evidence the Hub holds
// no Condition for, the System's page at that item.
export function AttentionLink({
  children,
  className,
  item,
  title,
}: {
  children: ReactNode;
  className?: string;
  item: Attention;
  title?: string;
}) {
  if (item.conditionId === undefined) {
    return (
      <Link
        className={className}
        hash={anchorOf(item)}
        params={{ name: item.system }}
        title={title}
        to="/systems/$name"
      >
        {children}
      </Link>
    );
  }
  return (
    <Link
      className={className}
      params={{ id: item.conditionId, name: item.system }}
      title={title}
      to="/systems/$name/conditions/$id"
    >
      {children}
    </Link>
  );
}

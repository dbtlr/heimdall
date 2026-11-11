import { useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { jumpIndexDue, jumpMatches, jumpTarget, moveActive, opensJump } from '../lib/jump.ts';
import type { JumpItem } from '../lib/jump.ts';
import { cn } from '../lib/utils.ts';
import type { JumpIndex } from '../server/jump-index-types.ts';

const KIND_NAMES: Record<JumpItem['kind'], string> = {
  project: 'Project',
  service: 'Service',
  session: 'Session',
  system: 'System',
};

const itemName = (item: JumpItem) => (item.kind === 'session' ? item.sessionId : item.name);

// What a result says beside its name: the System a Service or Session is on,
// and a Session's project.
const itemContext = (item: JumpItem) => {
  if (item.kind === 'service') {
    return `on ${item.system}`;
  }
  if (item.kind === 'session') {
    return [item.project, `on ${item.system}`].filter((part) => part !== undefined).join(' ');
  }
  return undefined;
};

// What the box says in place of results: that its names are still loading or
// could not be read, else that nothing matches.
const statusText = (index: JumpIndex | undefined, unread: boolean, query: string) => {
  if (index === undefined) {
    return unread ? 'The names could not be read.' : 'Loading…';
  }
  return `Nothing matches “${query.trim()}”.`;
};

// The jump box: a combobox over Systems, Services, projects, and Sessions by id
// prefix. The index of names is read when it gains focus, at most once a
// minute. Arrow keys move through the results, Enter opens the active one, and
// Escape closes.
// With `shortcut`, a bare `/` anywhere outside an editable field focuses it
// while it is visible.
// `wide` fills its container, with type sized for a phone.
export function JumpBox({
  loadIndex,
  shortcut = false,
  wide = false,
}: {
  loadIndex: () => Promise<JumpIndex>;
  shortcut?: boolean;
  wide?: boolean;
}) {
  const navigate = useNavigate();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const readAt = useRef<number>(undefined);
  const [index, setIndex] = useState<JumpIndex>();
  const [unread, setUnread] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<number>();
  const matches = index === undefined ? [] : jumpMatches(index, query);
  const expanded = open && query.trim() !== '';
  const current = active !== undefined && active < matches.length ? active : undefined;
  const optionId = (at: number) => `${id}-option-${String(at)}`;

  // Keeps the active option inside the scrolling list as the arrow keys move it.
  useEffect(() => {
    if (expanded && current !== undefined) {
      document
        .getElementById(`${id}-option-${String(current)}`)
        ?.scrollIntoView({ block: 'nearest' });
    }
  }, [expanded, current, id]);

  useEffect(() => {
    if (!shortcut) {
      return undefined;
    }
    const focusOnSlash = (event: globalThis.KeyboardEvent) => {
      // A DOM event's fields are getters, so they are copied by name.
      const { altKey, ctrlKey, key, metaKey, target } = event;
      const element = target instanceof HTMLElement ? target : null;
      // A box hidden at this width, as the top bar's is on a phone, leaves the
      // slash to the browser.
      const box = input.current;
      if (box?.checkVisibility() && opensJump({ altKey, ctrlKey, key, metaKey, target: element })) {
        event.preventDefault();
        box.focus();
      }
    };
    document.addEventListener('keydown', focusOnSlash);
    return () => {
      document.removeEventListener('keydown', focusOnSlash);
    };
  }, [shortcut]);

  const readIndex = async () => {
    if (!jumpIndexDue(readAt.current, Date.now())) {
      return;
    }
    try {
      setIndex(await loadIndex());
      readAt.current = Date.now();
      setUnread(false);
    } catch {
      setUnread(true);
    }
  };
  const close = () => {
    setQuery('');
    setActive(undefined);
    input.current?.blur();
  };
  const go = (item: JumpItem) => {
    close();
    void navigate(jumpTarget(item));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(moveActive(current, matches.length, event.key));
    } else if (event.key === 'Enter') {
      const chosen = matches[current ?? 0];
      if (expanded && chosen !== undefined) {
        event.preventDefault();
        go(chosen);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  return (
    <div className={cn('relative', wide ? 'w-full' : 'w-56 xl:w-64')}>
      <input
        aria-activedescendant={expanded && current !== undefined ? optionId(current) : undefined}
        aria-autocomplete="list"
        aria-controls={`${id}-list`}
        aria-expanded={expanded && matches.length > 0}
        aria-label="Jump to a System, Service, project, or Session"
        autoComplete="off"
        className={cn(
          'w-full rounded-lg border bg-background px-2.5 text-foreground outline-none placeholder:text-dim focus-visible:border-ring',
          wide ? 'h-11 text-base' : 'h-8 text-sm',
        )}
        onBlur={() => {
          setOpen(false);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onFocus={() => {
          setOpen(true);
          void readIndex();
        }}
        onKeyDown={onKeyDown}
        placeholder={shortcut ? 'Jump to…  /' : 'Jump to…'}
        ref={input}
        role="combobox"
        spellCheck={false}
        type="text"
        value={query}
      />
      <ul
        aria-label="Jump results"
        className={cn(
          'absolute right-0 z-50 mt-1 overflow-y-auto rounded-xl border bg-popover card-surface py-1',
          // The wide box sits on the More page: its list ends above the fixed bottom bar.
          wide
            ? 'left-0 max-h-[calc(100dvh-17rem)]'
            : 'max-h-[70vh] w-[min(26rem,calc(100vw-2rem))]',
          !(expanded && matches.length > 0) && 'hidden',
        )}
        id={`${id}-list`}
        role="listbox"
      >
        {expanded &&
          matches.map((item, at) => (
            <li
              aria-selected={at === current}
              className={cn(
                'flex min-h-10 cursor-pointer items-baseline gap-2 px-3 py-1.5 text-sm',
                at === current && 'bg-accent',
              )}
              id={optionId(at)}
              key={`${item.kind}:${itemName(item)}:${itemContext(item) ?? ''}`}
              onClick={() => {
                go(item);
              }}
              onMouseDown={(event) => {
                // Keeps focus in the box, so the list stays open for the click.
                event.preventDefault();
              }}
              onMouseMove={() => {
                setActive(at);
              }}
              role="option"
            >
              <span
                className={cn(
                  'min-w-0 truncate font-medium',
                  item.kind === 'session' && 'font-mono text-[13px]',
                )}
              >
                {itemName(item)}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {itemContext(item)}
              </span>
              <span className="shrink-0 text-xs text-dim">{KIND_NAMES[item.kind]}</span>
            </li>
          ))}
      </ul>
      {expanded && matches.length === 0 && (
        <p
          className={cn(
            'absolute right-0 z-50 mt-1 rounded-xl border card-surface px-3 py-2 text-sm text-muted-foreground',
            wide ? 'left-0' : 'w-[min(26rem,calc(100vw-2rem))]',
          )}
          role="status"
        >
          {statusText(index, unread, query)}
        </p>
      )}
    </div>
  );
}

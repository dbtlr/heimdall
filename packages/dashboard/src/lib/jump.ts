import type { JumpIndex, JumpSession } from '../server/jump-index-types.ts';

// One thing the jump box can open.
export type JumpItem =
  | { kind: 'project'; name: string }
  | { kind: 'service'; name: string; system: string }
  | ({ kind: 'session' } & JumpSession)
  | { kind: 'system'; name: string };

// How many results the jump box lists at most.
export const JUMP_LIMIT = 10;

const KIND_ORDER: Record<JumpItem['kind'], number> = {
  project: 2,
  service: 1,
  session: 3,
  system: 0,
};

const itemsOf = (index: JumpIndex): JumpItem[] => [
  ...index.systems.map((name) => ({ kind: 'system' as const, name })),
  ...index.services.map((service) => ({ kind: 'service' as const, ...service })),
  ...index.projects.map((name) => ({ kind: 'project' as const, name })),
  ...index.sessions.map((session) => ({ kind: 'session' as const, ...session })),
];

// 0 for a match at the start, 1 for one inside, undefined for none. A Session
// matches only by the start of its id.
const matchRank = (item: JumpItem, query: string): number | undefined => {
  const text = (item.kind === 'session' ? item.sessionId : item.name).toLowerCase();
  if (text.startsWith(query)) {
    return 0;
  }
  return item.kind !== 'session' && text.includes(query) ? 1 : undefined;
};

// The items `query` matches, ignoring case: Systems, then Services, projects,
// and Sessions; within a kind, matches at the start before matches inside,
// each in the index's order. At most `limit`; none for an empty query.
export const jumpMatches = (index: JumpIndex, query: string, limit = JUMP_LIMIT): JumpItem[] => {
  const wanted = query.trim().toLowerCase();
  if (wanted === '') {
    return [];
  }
  return itemsOf(index)
    .flatMap((item) => {
      const rank = matchRank(item, wanted);
      return rank === undefined ? [] : [{ item, rank }];
    })
    .toSorted((a, b) => KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.rank - b.rank)
    .slice(0, limit)
    .map(({ item }) => item);
};

// Where an item leads, as router navigation options; the last case is a
// Session. A project opens Agents over 30 days, broken down by project and
// picked to it.
export const jumpTarget = (item: JumpItem) => {
  switch (item.kind) {
    case 'system': {
      return { params: { name: item.name }, to: '/systems/$name' } as const;
    }
    case 'service': {
      return {
        params: { name: item.system, service: item.name },
        to: '/systems/$name/services/$service',
      } as const;
    }
    case 'project': {
      return {
        search: { by: 'project', pick: item.name, range: '30d' },
        to: '/agents',
      } as const;
    }
    default: {
      return {
        params: {
          harness: item.harness,
          name: item.system,
          sessionId: item.sessionId,
          source: item.source,
        },
        to: '/systems/$name/sessions/$harness/$source/$sessionId',
      } as const;
    }
  }
};

// The result the arrow key makes active among `count`, wrapping at either
// end; the first or last when none is.
export const moveActive = (
  active: number | undefined,
  count: number,
  key: 'ArrowDown' | 'ArrowUp',
): number | undefined => {
  if (count === 0) {
    return undefined;
  }
  const step = key === 'ArrowDown' ? 1 : -1;
  if (active === undefined) {
    return step === 1 ? 0 : count - 1;
  }
  return (active + step + count) % count;
};

type KeyPress = {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  target: { isContentEditable: boolean; tagName: string } | null;
};

const EDITABLE_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

// Whether a key press anywhere on the page should focus the jump box: a bare
// `/`, never while something editable has focus.
export const opensJump = ({ altKey, ctrlKey, key, metaKey, target }: KeyPress): boolean =>
  key === '/' &&
  !altKey &&
  !ctrlKey &&
  !metaKey &&
  (target === null || (!target.isContentEditable && !EDITABLE_TAGS.has(target.tagName)));

// How long the jump box keeps the index it read before reading it again.
export const JUMP_INDEX_FRESH_MS = 60_000;

// Whether the jump box should read its index on gaining focus at `now`: when it
// holds none, or the one it holds was read JUMP_INDEX_FRESH_MS or longer ago.
export const jumpIndexDue = (readAt: number | undefined, now: number): boolean =>
  readAt === undefined || now - readAt >= JUMP_INDEX_FRESH_MS;

// The room under a jump box's input that its result list may fill, in px: down
// to the top of the fixed bottom bar when it shows (`barTop` is undefined when
// it does not), or to the bottom of the visual viewport, whichever is higher,
// as an on-screen keyboard shrinks the viewport. Less `gap`, and never more
// than the room there is, so no result sits behind the bar or the keyboard.
export const JUMP_LIST_GAP = 8;
export const jumpListMaxHeight = ({
  barTop,
  inputBottom,
  viewportBottom,
}: {
  barTop: number | undefined;
  inputBottom: number;
  viewportBottom: number;
}): number =>
  Math.max(0, Math.min(barTop ?? viewportBottom, viewportBottom) - inputBottom - JUMP_LIST_GAP);

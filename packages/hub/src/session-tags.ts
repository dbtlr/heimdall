import { isRecord, isShaped, isStorableTime, MAX_ID_LENGTH } from './session-insight.ts';

// Reads a started conversation's role, review seat, and launching Session
// from its opening messages: a session tag, or T3 Code's sub-agent preamble
// when it has none (ADR-0025; docs/spec.md, Session tags). Pure, and shared by
// every Harness's parser, which decides what its opening messages are. Only
// shaped names and an id leave here, never a message's text.

// Where a conversation's role came from.
export type RoleSource = 'preamble' | 'tag';

// What a conversation's opening has given so far, carried in a parser's
// continuation state. `at` is the time of its first message; `closed` says its
// first response arrived, so nothing more is read. A `roleSource` of `tag`
// ends the search for a tag and a preamble.
export type Opening = {
  at: number;
  closed: boolean;
  launchingSessionId: string | null;
  role: string | null;
  roleSource: RoleSource | null;
  seat: string | null;
};

export type Tag = Pick<Opening, 'launchingSessionId' | 'role' | 'seat'>;

const PREFIX = 'session-tag:';
// A role or a seat: a lowercase letter, then at most 62 lowercase letters,
// digits, and `-`.
const NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const KEY = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const PREAMBLE = /^Act as the (?<role>\S+) sub-agent for this task\.$/u;

// A saved role or seat, or null when it is not shaped as one.
const nameOf = (field: unknown) => (typeof field === 'string' && NAME.test(field) ? field : null);

const isLaunchingId = (value: string) => value.length <= MAX_ID_LENGTH && isShaped(value, 'id');

// The tag a line holds; `misshapen` for a line that starts with the prefix and
// breaks the tag's rules, which the caller counts unreadable; null for a line
// that is no tag line at all.
export const tagOf = (line: string): Tag | 'misshapen' | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PREFIX)) {
    return null;
  }
  const rest = trimmed.slice(PREFIX.length).replace(/^[ \t]+/u, '');
  if (rest === '') {
    return 'misshapen';
  }
  const pairs = new Map<string, string>();
  for (const token of rest.split(/[ \t]+/u)) {
    const split = token.indexOf('=');
    const key = split === -1 ? '' : token.slice(0, split);
    const value = token.slice(split + 1);
    if (!KEY.test(key) || value === '' || pairs.has(key)) {
      return 'misshapen';
    }
    pairs.set(key, value);
  }
  const role = pairs.get('role');
  const seat = pairs.get('seat');
  const parent = pairs.get('parent');
  if (
    role === undefined ||
    !NAME.test(role) ||
    (seat !== undefined && !NAME.test(seat)) ||
    (parent !== undefined && !isLaunchingId(parent))
  ) {
    return 'misshapen';
  }
  return {
    launchingSessionId: parent ?? null,
    role,
    seat: role === 'review' ? (seat ?? null) : null,
  };
};

// The role T3 Code's preamble gives, or null for any other line.
export const preambleOf = (line: string): string | null => {
  const role = PREAMBLE.exec(line.trim())?.groups?.role;
  return role !== undefined && NAME.test(role) ? role : null;
};

const LINE_BREAK = /\r\n|\n|\r/u;

// A message's text, as both Harnesses write it: its string content, or each
// content block's `text`, in order. A block with no text, such as an image or
// a tool result, adds none.
export const messageTexts = (content: unknown): string[] => {
  if (typeof content === 'string') {
    return [content];
  }
  return (Array.isArray(content) ? content : []).flatMap((block) =>
    isRecord(block) && typeof block.text === 'string' ? [block.text] : [],
  );
};

// Reads one opening message, timed `at`, whose text is `texts`: its string
// content or each content block's text, each split into lines on its own.
// `unreadable` says the message held a misshapen tag line before the first
// well-formed tag, so its record counts one unreadable line.
export const readOpeningMessage = (
  opening: Opening | null,
  at: number,
  texts: readonly string[],
): { opening: Opening; unreadable: boolean } => {
  const next: Opening =
    opening === null
      ? {
          at,
          closed: false,
          launchingSessionId: null,
          role: null,
          roleSource: null,
          seat: null,
        }
      : { ...opening };
  if (next.closed) {
    return { opening: next, unreadable: false };
  }
  let unreadable = false;
  for (const line of texts.flatMap((text) => text.split(LINE_BREAK))) {
    if (next.roleSource === 'tag') {
      break;
    }
    const tag = tagOf(line);
    if (tag === 'misshapen') {
      unreadable = true;
    } else if (tag !== null) {
      Object.assign(next, tag, { roleSource: 'tag' });
    } else if (next.roleSource === null) {
      const role = preambleOf(line);
      if (role !== null) {
        Object.assign(next, { role, roleSource: 'preamble', seat: null });
      }
    }
  }
  return { opening: next, unreadable };
};

// The opening once its first response arrived, or null when there is none.
export const closeOpening = (opening: Opening | null): Opening | null =>
  opening === null ? null : { ...opening, closed: true };

// An opening read back from continuation state, which the database returns as
// JSON, closed when `answered` says its first response arrived. It is null
// when it holds none or its time is not one a line may hold. Its facts come
// back only together, as the parser kept them: all four are null unless its
// role and the role's source read back, and its seat and launching Session
// come only from a tag.
const openingOf = (value: unknown, answered: boolean): Opening | null => {
  if (!isRecord(value) || typeof value.at !== 'number' || !isStorableTime(value.at)) {
    return null;
  }
  const role = nameOf(value.role);
  const source =
    role !== null && (value.roleSource === 'tag' || value.roleSource === 'preamble')
      ? value.roleSource
      : null;
  const tagged = source === 'tag';
  return {
    at: value.at,
    closed: answered,
    launchingSessionId:
      tagged &&
      typeof value.launchingSessionId === 'string' &&
      isLaunchingId(value.launchingSessionId)
        ? value.launchingSessionId
        : null,
    role: source === null ? null : role,
    roleSource: source,
    seat: tagged && role === 'review' ? nameOf(value.seat) : null,
  };
};

// What a parser carries of a conversation's opening from one batch to the
// next: what the opening gave so far, and whether the first response arrived,
// which ends the opening even when there was none.
export type OpeningProgress = { answered: boolean; opening: Opening | null };

export const progressOf = (value: unknown): OpeningProgress => {
  const saved: Record<string, unknown> = isRecord(value) ? value : {};
  const answered = saved.answered === true;
  return { answered, opening: openingOf(saved.opening, answered) };
};

// Reads a batch's share of an opening from `progress`. `message` reads an
// opening message and answers whether its record counts unreadable; `respond`
// marks the first response. `reported` is the opening when the batch read or
// closed it, so the batch reports it, and null otherwise.
export const openingReader = (progress: OpeningProgress) => {
  let { answered, opening } = progress;
  let changed = false;
  return {
    message: (at: number, texts: readonly string[]): boolean => {
      if (answered) {
        return false;
      }
      const read = readOpeningMessage(opening, at, texts);
      opening = read.opening;
      changed = true;
      return read.unreadable;
    },
    get progress(): OpeningProgress {
      return { answered, opening };
    },
    get reported(): Opening | null {
      return changed ? opening : null;
    },
    respond: () => {
      if (answered) {
        return;
      }
      answered = true;
      if (opening !== null) {
        opening = closeOpening(opening);
        changed = true;
      }
    },
  };
};

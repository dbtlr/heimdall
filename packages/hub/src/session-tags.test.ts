import { describe, expect, test } from 'bun:test';

import {
  closeOpening,
  messageTexts,
  preambleOf,
  progressOf,
  readOpeningMessage,
  tagOf,
} from './session-tags.ts';
import type { Opening } from './session-tags.ts';

const PARENT = '0b1c2d3e-0000-4000-8000-0000000000aa';

describe('a session tag line', () => {
  test('names a role, a review seat, and a launching Session', () => {
    expect(tagOf(`session-tag: role=review seat=breaker parent=${PARENT}`)).toEqual({
      launchingSessionId: PARENT,
      role: 'review',
      seat: 'breaker',
    });
  });

  test('is read after leading whitespace, and through runs of spaces and tabs', () => {
    expect(tagOf(`   \tsession-tag:  role=review\tseat=verifier   \r`)).toEqual({
      launchingSessionId: null,
      role: 'review',
      seat: 'verifier',
    });
    expect(tagOf('session-tag:role=implementation')).toEqual({
      launchingSessionId: null,
      role: 'implementation',
      seat: null,
    });
  });

  test('keeps a seat only on a review role, after checking its shape', () => {
    expect(tagOf('session-tag: role=implementation seat=breaker')).toEqual({
      launchingSessionId: null,
      role: 'implementation',
      seat: null,
    });
    expect(tagOf('session-tag: role=implementation seat=Breaker')).toBe('misshapen');
  });

  test('a review tag without a seat has an unknown seat', () => {
    expect(tagOf('session-tag: role=review')).toEqual({
      launchingSessionId: null,
      role: 'review',
      seat: null,
    });
  });

  test('ignores unknown keys, matched as written, whatever their value', () => {
    expect(tagOf('session-tag: role=design task_id=HMD-302 Role=x note=a=b')).toEqual({
      launchingSessionId: null,
      role: 'design',
      seat: null,
    });
  });

  test('keeps a role or seat the Hub has never seen, up to 63 characters', () => {
    const long = `a${'b'.repeat(62)}`;
    expect(tagOf(`session-tag: role=review seat=${long}`)).toEqual({
      launchingSessionId: null,
      role: 'review',
      seat: long,
    });
    expect(tagOf(`session-tag: role=review seat=${long}c`)).toBe('misshapen');
  });

  test.each([
    [
      'the template the instructions quote',
      'session-tag: role=<role> seat=<seat> parent=<session id>',
    ],
    ['no role', 'session-tag: seat=breaker'],
    ['nothing after the prefix', 'session-tag:'],
    ['an empty value', 'session-tag: role=review seat='],
    ['a repeated key', 'session-tag: role=review role=design'],
    ['a repeated unknown key', 'session-tag: role=review note=a note=b'],
    ['text that is not a pair', 'session-tag: role=review and more prose'],
    ['an uppercase role', 'session-tag: role=Review'],
    ['a role that starts with a digit', 'session-tag: role=1st'],
    ['a parent not shaped as an id', 'session-tag: role=review parent=<id>'],
    ['a parent longer than an id may be', `session-tag: role=review parent=${'a'.repeat(256)}`],
  ])('with %s is misshapen', (_, line) => {
    expect(tagOf(line)).toBe('misshapen');
  });

  test.each([
    ['prose that mentions the prefix', 'Start each brief with `session-tag: role=review`.'],
    ['a different prefix', 'session-tags: role=review'],
    ['an empty line', ''],
  ])('with %s is no tag line at all', (_, line) => {
    expect(tagOf(line)).toBeNull();
  });
});

describe("T3 Code's preamble", () => {
  test('gives its role, held to the shape of a tag role', () => {
    expect(preambleOf('  Act as the review sub-agent for this task.  ')).toBe('review');
    expect(preambleOf('Act as the design-rater sub-agent for this task.')).toBe('design-rater');
  });

  test('must read exactly', () => {
    expect(preambleOf('Act as the Review sub-agent for this task.')).toBeNull();
    expect(preambleOf('Act as the review sub-agent for this task')).toBeNull();
    expect(preambleOf('Please act as the review sub-agent for this task.')).toBeNull();
    expect(preambleOf('Act as the code reviewer sub-agent for this task.')).toBeNull();
  });
});

const T0 = Date.parse('2026-11-24T00:00:00.000Z');
const T1 = T0 + 1000;

const read = (texts: string[], opening: Opening | null = null, at = T0) =>
  readOpeningMessage(opening, at, texts);

describe('reading an opening', () => {
  test('a built-in subagent: the tag on its first line', () => {
    const { opening, unreadable } = read([
      `session-tag: role=review seat=architect parent=${PARENT}\nReview the diff.`,
    ]);
    expect(unreadable).toBe(false);
    expect(opening).toEqual({
      at: T0,
      closed: false,
      launchingSessionId: PARENT,
      role: 'review',
      roleSource: 'tag',
      seat: 'architect',
    });
  });

  test('a workflow agent: a header line, then an indented tag', () => {
    const { opening } = read([
      `<harness header>\n    session-tag: role=implementation parent=${PARENT}\n    Do the work.`,
    ]);
    expect(opening?.role).toBe('implementation');
    expect(opening?.roleSource).toBe('tag');
  });

  test('a T3 Session: the header, the preamble, then the tag, which wins', () => {
    const { opening } = read([
      `[T3 Code: delegated task]\nAct as the review sub-agent for this task.\nsession-tag: role=review seat=breaker parent=${PARENT}\nBrief.`,
    ]);
    expect(opening).toMatchObject({ role: 'review', roleSource: 'tag', seat: 'breaker' });
  });

  test('a preamble with no tag gives the role, no seat, and no launching Session', () => {
    const { opening } = read([
      '[T3 Code: delegated task]\nAct as the review sub-agent for this task.\nBrief.',
    ]);
    expect(opening).toMatchObject({
      launchingSessionId: null,
      role: 'review',
      roleSource: 'preamble',
      seat: null,
    });
  });

  test('a tag in a later opening message still wins over an earlier preamble', () => {
    const first = read(['Act as the review sub-agent for this task.']).opening;
    const { opening } = read(['session-tag: role=design'], first, T1);
    expect(opening).toMatchObject({ at: T0, role: 'design', roleSource: 'tag' });
  });

  test('the template quoted mid-sentence is no tag and nothing unreadable', () => {
    const { opening, unreadable } = read([
      'Start every brief with a tag line, `session-tag: role=<role> seat=<seat> parent=<session id>`, then the task.',
    ]);
    expect(unreadable).toBe(false);
    expect(opening).toMatchObject({ role: null, roleSource: null });
  });

  test('a misshapen tag is unreadable, and the good tag after it counts', () => {
    const { opening, unreadable } = read([
      'session-tag: role=<role>\nsession-tag: role=Review\nsession-tag: role=review seat=verifier',
    ]);
    expect(unreadable).toBe(true);
    expect(opening).toMatchObject({ role: 'review', seat: 'verifier' });
  });

  test('the first well-formed tag ends the search, so later tag lines are not read', () => {
    const { opening, unreadable } = read([
      'session-tag: role=review\nsession-tag: role=<late>\nsession-tag: role=design',
    ]);
    expect(unreadable).toBe(false);
    expect(opening?.role).toBe('review');
    const later = read(['session-tag: role=<role>', 'session-tag: role=design'], opening, T1);
    expect(later.unreadable).toBe(false);
    expect(later.opening?.role).toBe('review');
  });

  test('each block is split on its own, so two blocks never join into one line', () => {
    const { opening } = read(['header', 'session-tag: role=review']);
    expect(opening?.role).toBe('review');
  });

  test('lines split at CRLF and at a bare carriage return', () => {
    expect(read(['header\r\nsession-tag: role=review\r\n']).opening?.role).toBe('review');
    expect(read(['header\rsession-tag: role=design']).opening?.role).toBe('design');
  });

  test("the opening's time is its first message's, and closing keeps the facts", () => {
    const first = read(['hello']).opening;
    const second = read(['session-tag: role=review'], first, T1).opening;
    expect(second?.at).toBe(T0);
    expect(closeOpening(second)).toEqual({ ...second, closed: true });
    expect(closeOpening(null)).toBeNull();
  });

  test('a closed opening reads nothing more', () => {
    const closed = { ...read(['hello']).opening, closed: true };
    const { opening, unreadable } = read(
      ['session-tag: role=<role>', 'session-tag: role=review'],
      closed,
      T1,
    );
    expect(unreadable).toBe(false);
    expect(opening).toEqual(closed);
  });
});

// An opening read back as the database returns saved continuation state.
const saved = (opening: Record<string, unknown>, answered = false) =>
  progressOf(structuredClone({ answered, opening }));

describe('an opening carried in continuation state', () => {
  test('round-trips, and is closed exactly when the first response arrived', () => {
    const { opening } = read([`session-tag: role=review seat=breaker parent=${PARENT}`]);
    expect(saved(opening)).toEqual({ answered: false, opening });
    expect(saved({ ...opening, closed: false }, true)).toEqual({
      answered: true,
      opening: { ...opening, closed: true },
    });
    expect(saved({ ...opening, closed: true }, false).opening?.closed).toBe(false);
  });

  test('holds no opening when absent, or when its time is not a storable time', () => {
    expect(progressOf(undefined)).toEqual({ answered: false, opening: null });
    expect(saved({ at: 'soon' }).opening).toBeNull();
    expect(saved({ at: 1e20 }).opening).toBeNull();
    expect(saved({ at: Date.parse('0001-01-01T00:00:00.000Z') - 1 }).opening).toBeNull();
  });

  test('keeps the facts only together: all four are null unless the role and its source read back', () => {
    const none = { launchingSessionId: null, role: null, roleSource: null, seat: null };
    expect(
      saved({ at: T0, launchingSessionId: PARENT, role: 'Review', roleSource: 'tag', seat: 'x' })
        .opening,
    ).toEqual({
      at: T0,
      closed: false,
      ...none,
    });
    expect(
      saved({ at: T0, launchingSessionId: PARENT, role: 'design', roleSource: 'bogus', seat: 'x' })
        .opening,
    ).toEqual({
      at: T0,
      closed: false,
      ...none,
    });
  });

  test('keeps a seat only for a tagged review, and a launching Session only from a tag', () => {
    expect(
      saved({
        at: T0,
        launchingSessionId: PARENT,
        role: 'review',
        roleSource: 'preamble',
        seat: 'breaker',
      }).opening,
    ).toEqual(
      expect.objectContaining({
        launchingSessionId: null,
        role: 'review',
        roleSource: 'preamble',
        seat: null,
      }),
    );
    expect(
      saved({
        at: T0,
        launchingSessionId: PARENT,
        role: 'design',
        roleSource: 'tag',
        seat: 'breaker',
      }).opening,
    ).toEqual(expect.objectContaining({ launchingSessionId: PARENT, role: 'design', seat: null }));
    expect(
      saved({
        at: T0,
        launchingSessionId: 'a b',
        role: 'review',
        roleSource: 'tag',
        seat: 'breaker',
      }).opening,
    ).toEqual(expect.objectContaining({ launchingSessionId: null, seat: 'breaker' }));
  });
});

describe("a message's text", () => {
  test("is its string content, or each content block's text in order", () => {
    expect(messageTexts('hello')).toEqual(['hello']);
    expect(
      messageTexts([
        { text: 'one', type: 'text' },
        { text: 'two', type: 'input_text' },
        { content: 'a tool result', type: 'tool_result' },
        { source: {}, type: 'image' },
        'stray',
      ]),
    ).toEqual(['one', 'two']);
    expect(messageTexts(undefined)).toEqual([]);
  });

  test('of only one type of block when one is named', () => {
    expect(
      messageTexts(
        [
          { text: 'one', type: 'text' },
          { text: 'not prose', type: 'tool_result' },
        ],
        'text',
      ),
    ).toEqual(['one']);
  });
});

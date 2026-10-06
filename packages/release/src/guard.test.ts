import { describe, expect, test } from 'bun:test';

import { judgeChanges } from './guard.ts';
import type { Change } from './guard.ts';

const added = (path: string): Change => ({ path, status: 'added' });
const modified = (path: string): Change => ({ path, status: 'modified' });
const deleted = (path: string): Change => ({ path, status: 'deleted' });

const judge = (changes: Change[], { skipLabel = false, versionChanged = false } = {}) =>
  judgeChanges({ changes, skipLabel, versionChanged });

describe('judgeChanges', () => {
  test('passes a change to nothing that ships', () => {
    expect(judge([modified('docs/roadmap.md')])).toEqual({
      fragments: [],
      reason: 'Nothing that ships changed; no fragment needed.',
      verdict: 'pass',
    });
  });

  test.each([
    'packages/hub/src/hub.ts',
    'package.json',
    'bun.lock',
    'bunfig.toml',
    'mise.toml',
    'install-hub.sh',
    '.github/workflows/release.yml',
    'packages/collector/src/ünicode.ts',
  ])('fails a change to %s without a fragment', (path) => {
    expect(judge([modified(path)]).verdict).toBe('fail');
  });

  test('passes a shipped change with an added or edited fragment, and names it for parsing', () => {
    expect(judge([modified('packages/hub/src/hub.ts'), added('.changes/hmd-1.md')])).toEqual({
      fragments: ['.changes/hmd-1.md'],
      reason: 'Fragments present: .changes/hmd-1.md.',
      verdict: 'pass',
    });
    expect(judge([modified('install-hub.sh'), modified('.changes/hmd-1.md')]).fragments).toEqual([
      '.changes/hmd-1.md',
    ]);
  });

  test('names every added fragment for parsing even when nothing that ships changed', () => {
    expect(judge([added('.changes/bad.md')]).fragments).toEqual(['.changes/bad.md']);
    expect(
      judge([modified('packages/hub/src/hub.ts'), added('.changes/x.md')], { skipLabel: true })
        .fragments,
    ).toEqual(['.changes/x.md']);
  });

  test('does not count the fragment guide or a nested file as a fragment', () => {
    expect(judge([modified('package.json'), modified('.changes/README.md')]).verdict).toBe('fail');
    expect(judge([modified('package.json'), added('.changes/old/x.md')]).verdict).toBe('fail');
  });

  test('fails a fragment whose name the cut would not compile safely', () => {
    const verdict = judge([modified('package.json'), added('.changes/bäd name.md')]);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.reason).toContain('.changes/bäd name.md');
  });

  test('passes a shipped change with the skip-changelog label', () => {
    expect(judge([modified('bun.lock')], { skipLabel: true }).verdict).toBe('pass');
  });

  test('passes the release cut: fragments compiled away and the version moved', () => {
    const cut = [
      modified('CHANGELOG.md'),
      modified('packages/collector/package.json'),
      modified('packages/hub/package.json'),
      modified('bun.lock'),
      deleted('.changes/hmd-1.md'),
    ];
    expect(judge(cut, { versionChanged: true })).toEqual({
      fragments: [],
      reason: 'The release cut: only the version and the changelog changed.',
      verdict: 'pass',
    });
  });

  test('passes the prerelease cut: only the version moved', () => {
    const cut = [
      modified('packages/collector/package.json'),
      modified('packages/hub/package.json'),
      modified('bun.lock'),
    ];
    expect(judge(cut, { versionChanged: true }).verdict).toBe('pass');
  });

  test('fails a shipped change that deletes a fragment and adds none', () => {
    expect(
      judge([modified('packages/collector/src/a.ts'), deleted('.changes/old.md')], {
        versionChanged: true,
      }).verdict,
    ).toBe('fail');
  });

  test('fails the cut shape when the version did not move', () => {
    expect(judge([modified('packages/hub/package.json'), deleted('.changes/old.md')]).verdict).toBe(
      'fail',
    );
  });
});

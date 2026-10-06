import { describe, expect, test } from 'bun:test';

import { insertSection, parseFragment, releaseNotes, renderSection } from './changelog.ts';

describe('parseFragment', () => {
  test('reads bullets under each category heading', () => {
    const sections = parseFragment(
      '.changes/hmd-11.md',
      '### Added\n\n- **Releases** (HMD-11). Binaries for\n  every platform.\n\n### Fixed\n\n- A fix.\n',
    );
    expect(sections).toEqual({
      Added: ['- **Releases** (HMD-11). Binaries for\n  every platform.'],
      Fixed: ['- A fix.'],
    });
  });

  test('accepts tab-indented continuation lines', () => {
    expect(parseFragment('f.md', '### Added\n\n- One\n\tmore.\n')).toEqual({
      Added: ['- One\n\tmore.'],
    });
  });

  test('keeps each bullet of one category as its own entry', () => {
    expect(parseFragment('f.md', '### Changed\n\n- One.\n- Two.\n')).toEqual({
      Changed: ['- One.', '- Two.'],
    });
  });

  test.each([
    ['### Improved\n\n- x\n', 'f.md:1: unknown category "Improved"'],
    ['## Added\n\n- x\n', 'f.md:1: only H3 category headings'],
    ['- x\n', 'f.md:1: bullet outside a category heading'],
    ['### Added\n\nSome prose.\n', 'f.md:3: prose outside a bullet'],
    ['### Added\n\n  indented\n', 'f.md:3: continuation line outside a bullet'],
    ['### Added\n\n* x\n', 'f.md:3: prose outside a bullet'],
    ['', 'f.md:1: fragment has no entries'],
    ['### Added\n', 'f.md:1: fragment has no entries'],
    ['### Added\n\n- ok\r## v9.9.9 - 2020-01-01\n', 'f.md:3: control character'],
    ['### Added\n\n- \u001b[31mred\n', 'f.md:3: control character'],
    ['### Added\n\n- \n', 'f.md:3: empty bullet'],
    ['### Added\n\n-  \n', 'f.md:3: empty bullet'],
    ['### Added\n\n- ok\n\u00a0more\n', 'f.md:4: prose outside a bullet'],
    ['### Added\r\n\r\n- ok\r\n', 'f.md:1: control character'],
    ['### Added\n\n- a\u009b31m\n', 'f.md:3: control character'],
    ['### Added\n\n- a\u202eb\n', 'f.md:3: control character'],
    ['### Added\n\n- \u200b\n', 'f.md:3: control character'],
  ])('rejects %j', (text, message) => {
    expect(() => parseFragment('f.md', text)).toThrow(message);
  });
});

describe('renderSection', () => {
  test('groups entries by category in Keep a Changelog order, keeping fragment order', () => {
    const section = renderSection('0.2.0', '2026-10-06', [
      { Fixed: ['- First fix.'] },
      { Added: ['- A feature.'], Fixed: ['- Second fix.'] },
    ]);
    expect(section).toBe(
      '## v0.2.0 - 2026-10-06\n\n### Added\n\n- A feature.\n\n### Fixed\n\n- First fix.\n- Second fix.\n',
    );
  });
});

describe('insertSection', () => {
  const header = '# Changelog\n\nReleased changes.\n';

  test('puts the first release below the header', () => {
    expect(insertSection(header, '## v0.1.0 - 2026-10-06\n\n### Added\n\n- x\n')).toBe(
      '# Changelog\n\nReleased changes.\n\n## v0.1.0 - 2026-10-06\n\n### Added\n\n- x\n',
    );
  });

  test('puts a new release above the previous one', () => {
    const changelog = `${header}\n## v0.1.0 - 2026-10-06\n\n### Added\n\n- x\n`;
    expect(insertSection(changelog, '## v0.2.0 - 2026-10-07\n\n### Fixed\n\n- y\n')).toBe(
      `${header}\n## v0.2.0 - 2026-10-07\n\n### Fixed\n\n- y\n\n## v0.1.0 - 2026-10-06\n\n### Added\n\n- x\n`,
    );
  });
});

describe('releaseNotes', () => {
  const changelog =
    '# Changelog\n\n## v0.2.0 - 2026-10-07\n\n### Fixed\n\n- y\n\n## v0.1.0 - 2026-10-06\n\n### Added\n\n- x\n';

  test("returns one release's entries without its heading", () => {
    expect(releaseNotes(changelog, '0.2.0')).toBe('### Fixed\n\n- y\n');
    expect(releaseNotes(changelog, '0.1.0')).toBe('### Added\n\n- x\n');
  });

  test('keeps an H2 inside a release that is not a release heading', () => {
    const withGuide =
      '# Changelog\n\n## v0.2.0 - 2026-10-07\n\n- y\n\n## Upgrade guide\n\nSteps.\n\n## v0.1.0 - 2026-10-06\n\n- x\n';
    expect(releaseNotes(withGuide, '0.2.0')).toBe('- y\n\n## Upgrade guide\n\nSteps.\n');
  });

  test('answers undefined for a release the changelog does not hold', () => {
    expect(releaseNotes(changelog, '0.3.0')).toBeUndefined();
    expect(releaseNotes(changelog, '0.1')).toBeUndefined();
  });
});

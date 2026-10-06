// The changelog grammar. A fragment in `.changes/` holds Keep a Changelog
// entries: H3 category headings and `- ` bullets, nothing else. A release cut
// concatenates the fragments into one `## vX.Y.Z - YYYY-MM-DD` section of
// CHANGELOG.md and never rewrites their prose.

export const CATEGORIES = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
] as const;
export type Category = (typeof CATEGORIES)[number];

// One fragment's entries by category. An entry is one bullet with its
// continuation lines, verbatim.
export type FragmentSections = Partial<Record<Category, string[]>>;

const isCategory = (heading: string): heading is Category =>
  (CATEGORIES as readonly string[]).includes(heading);

// Characters that would change how CHANGELOG.md renders or prints: a lone CR
// is a Markdown line break, and terminal escapes survive into release notes.
// A tab is allowed.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B-\u001F\u007F\u0085\u2028\u2029]/u;

const BLANK = /^[ \t]*$/u;
const INDENTED = /^[ \t]/u;

const fail = (file: string, line: number, message: string): never => {
  throw new Error(`${file}:${String(line)}: ${message}`);
};

// Parses one fragment strictly, so the guard rejects at review what the cut
// would otherwise publish malformed. Errors name the file and line.
export const parseFragment = (file: string, text: string): FragmentSections => {
  const sections: FragmentSections = {};
  let category: Category | undefined;
  let entry: string[] = [];

  const flush = () => {
    while (entry.length > 0 && BLANK.test(entry.at(-1) ?? '')) {
      entry.pop();
    }
    if (category !== undefined && entry.length > 0) {
      (sections[category] ??= []).push(entry.join('\n'));
    }
    entry = [];
  };

  for (const [index, line] of text.split('\n').entries()) {
    const at = index + 1;
    if (CONTROL_CHARACTER.test(line)) {
      fail(file, at, 'control character; fragments hold plain text with LF line endings');
    }
    const heading = /^### (?<name>.*)$/u.exec(line)?.groups?.name?.trim();
    if (heading !== undefined) {
      if (!isCategory(heading)) {
        return fail(file, at, `unknown category "${heading}"; use one of ${CATEGORIES.join(', ')}`);
      }
      flush();
      category = heading;
    } else if (line.startsWith('#')) {
      fail(file, at, 'only H3 category headings are allowed in a fragment');
    } else if (line.startsWith('- ')) {
      if (category === undefined) {
        fail(file, at, 'bullet outside a category heading');
      }
      if (BLANK.test(line.slice(2))) {
        fail(file, at, 'empty bullet');
      }
      flush();
      entry.push(line);
    } else if (BLANK.test(line)) {
      if (entry.length > 0) {
        entry.push(line);
      }
    } else if (INDENTED.test(line)) {
      if (entry.length === 0) {
        fail(file, at, 'continuation line outside a bullet');
      }
      entry.push(line);
    } else {
      fail(file, at, 'prose outside a bullet; entries are `- ` bullets under a category heading');
    }
  }
  flush();

  if (Object.keys(sections).length === 0) {
    fail(file, 1, 'fragment has no entries');
  }
  return sections;
};

const heading = (version: string, date: string) => `## v${version} - ${date}`;

// Renders a release's entries. Categories follow Keep a Changelog's order, and
// within a category the entries keep the order of the fragments given.
export const renderEntries = (fragments: readonly FragmentSections[]): string => {
  const parts: string[] = [];
  for (const category of CATEGORIES) {
    const entries = fragments.flatMap((sections) => sections[category] ?? []);
    if (entries.length > 0) {
      parts.push(`### ${category}`, entries.join('\n'));
    }
  }
  return `${parts.join('\n\n')}\n`;
};

// Renders one release section: its heading, then its entries.
export const renderSection = (
  version: string,
  date: string,
  fragments: readonly FragmentSections[],
): string => `${heading(version, date)}\n\n${renderEntries(fragments)}`;

// A prerelease (X.Y.Z-pre) gets no section of its own; its fragments stay
// pending for the release it leads up to.
export const isPrerelease = (version: string): boolean => version.includes('-');

const RELEASE_HEADING = /^## v(?<version>\S+) - /u;

// Inserts a release section above the newest one, or after the header when the
// changelog holds no release yet.
export const insertSection = (changelog: string, section: string): string => {
  const lines = changelog.split('\n');
  const newest = lines.findIndex((line) => RELEASE_HEADING.test(line));
  if (newest === -1) {
    return `${changelog.trimEnd()}\n\n${section}`;
  }
  return [...lines.slice(0, newest), section, ...lines.slice(newest)].join('\n');
};

// The entries of one release, without its heading: the GitHub Release notes.
export const releaseNotes = (changelog: string, version: string): string | undefined => {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => RELEASE_HEADING.exec(line)?.groups?.version === version);
  if (start === -1) {
    return undefined;
  }
  const next = lines.findIndex((line, index) => index > start && RELEASE_HEADING.test(line));
  const body = lines.slice(start + 1, next === -1 ? undefined : next).join('\n');
  return `${body.trim()}\n`;
};

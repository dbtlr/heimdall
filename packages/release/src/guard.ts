// The changelog guard's rule. A pull request that changes what a release builds
// adds or edits a fragment, unless it carries the skip-changelog label or is a
// release cut. Loom checks every pending fragment whatever the PR changes, so a
// malformed one never waits for the cut to be found.

export type Change = { path: string; status: 'added' | 'deleted' | 'modified' };

export type Judgement = {
  // Fragments the PR adds or edits, which the guard names and requires.
  fragments: string[];
  reason: string;
  verdict: 'fail' | 'pass';
};

// What a release builds from. Keep in step with release.yml's pull_request paths.
const SHIPS =
  /^(?:packages\/|package\.json$|bun\.lock$|bunfig\.toml$|mise\.toml$|install-[^/]+\.sh$|\.github\/workflows\/release\.yml$)/u;

const FRAGMENT = /^\.changes\/[^/]+\.md$/u;
// A name `loom changelog` accepts as `<slug>.md`, `feature.<slug>.md`, or
// `breaking.<slug>.md`, in characters the workflow handles without quoting.
const FRAGMENT_NAME = /^\.changes\/(?!(?:breaking|feature)\.md$)[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u;
const GUIDE = '.changes/README.md';

// The files a release cut changes, besides the fragments it deletes.
const CUT_FILES = new Set([
  'CHANGELOG.md',
  'bun.lock',
  'packages/collector/package.json',
  'packages/dashboard/package.json',
  'packages/hub/package.json',
]);

const isFragment = (path: string) => FRAGMENT.test(path) && path !== GUIDE;

export const judgeChanges = ({
  changes,
  skipLabel,
  versionChanged,
}: {
  changes: readonly Change[];
  skipLabel: boolean;
  // Whether the released packages' version differs from the base's.
  versionChanged: boolean;
}): Judgement => {
  const fragments = changes
    .filter(({ path, status }) => status !== 'deleted' && isFragment(path))
    .map(({ path }) => path);
  const judged = (verdict: Judgement['verdict'], reason: string): Judgement => ({
    fragments,
    reason,
    verdict,
  });

  const misnamed = fragments.filter((path) => !FRAGMENT_NAME.test(path));
  if (misnamed.length > 0) {
    return judged(
      'fail',
      `Rename ${misnamed.join(', ')} to <slug>.md, feature.<slug>.md, or breaking.<slug>.md, with a slug of letters, digits, dots, dashes, and underscores, such as .changes/feature.hmd-11-tags.md.`,
    );
  }
  if (!changes.some(({ path }) => SHIPS.test(path))) {
    return judged('pass', 'Nothing that ships changed; no fragment needed.');
  }
  if (skipLabel) {
    return judged('pass', 'The skip-changelog label waives the fragment.');
  }
  if (fragments.length > 0) {
    return judged('pass', `Fragments present: ${fragments.join(', ')}.`);
  }
  const isCut = changes.every(
    ({ path, status }) => CUT_FILES.has(path) || (status === 'deleted' && isFragment(path)),
  );
  if (isCut && versionChanged) {
    return judged('pass', 'The release cut: only the version and the changelog changed.');
  }
  return judged(
    'fail',
    'This PR changes what ships but adds no fragment. Add .changes/<slug>.md, feature.<slug>.md, or breaking.<slug>.md (see .changes/README.md), or apply the skip-changelog label when no entry is due.',
  );
};

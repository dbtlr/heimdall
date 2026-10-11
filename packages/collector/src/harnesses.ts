export const HARNESS_NAMES = ['claude-code', 'codex'] as const;

export type Harness = (typeof HARNESS_NAMES)[number];

// Where a Harness installs to, by kind of place. The Collector finds a Harness
// from these places alone and never runs it.
export type HarnessInstallPlaces = {
  // Homebrew formula and cask names: each version has a directory of its own
  // under the Cellar or Caskroom.
  homebrew: readonly string[];
  // mise tool directory names under `installs`: each version has a directory.
  mise: readonly string[];
  // A directory under the home directory whose entries are named by version,
  // such as the Harness's own native installer keeps.
  native?: string;
  // npm package names: a global install has a `package.json` naming the version.
  npm: readonly string[];
};

// The one list of Harnesses the Collector knows. A Harness has the directory
// under the home directory it keeps its state in and the trees within it that
// hold transcripts, and the places its installs are found. Transcript capture,
// installed versions, and process observation all read it.
export const HARNESSES: Record<
  Harness,
  { defaultDir: string; installs: HarnessInstallPlaces; trees: readonly string[] }
> = {
  'claude-code': {
    defaultDir: '.claude',
    installs: {
      homebrew: ['claude-code'],
      mise: ['claude', 'npm-anthropic-ai-claude-code'],
      native: '.local/share/claude/versions',
      npm: ['@anthropic-ai/claude-code'],
    },
    trees: ['projects'],
  },
  codex: {
    defaultDir: '.codex',
    installs: {
      homebrew: ['codex'],
      mise: ['codex', 'npm-openai-codex'],
      npm: ['@openai/codex'],
    },
    trees: ['sessions'],
  },
};

export const isHarness = (value: string): value is Harness => Object.hasOwn(HARNESSES, value);

import { readConfigSection } from '@heimdall/service';
import { z } from 'zod';

const httpUrl = z
  .url({ protocol: /^https?$/ })
  // A base address resolves links below its path only when the path ends in a slash.
  .transform((value) => {
    const url = new URL(value);
    if (!url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url;
  });

// ntfy's own rule for a topic name.
const topic = z.string().regex(/^[-_A-Za-z0-9]{1,64}$/);

const section = z.strictObject({
  dashboard: httpUrl,
  token: z.string().min(1).optional(),
  topic,
  url: httpUrl,
});

// Where the Hub delivers alerts: the ntfy server, its topic, an optional
// access token, and the dashboard's address for links (ADR-0020).
export type DeliveryChannel = z.infer<typeof section>;

// What is wrong with one setting, named by its key and never its value.
const describeIssue = (issue: z.core.$ZodIssue): string => {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => `delivery.${key}: not a setting`).join('; ');
  }
  const [setting] = issue.path;
  switch (setting) {
    case undefined: {
      return 'delivery: expected a table';
    }
    case 'dashboard':
    case 'url': {
      return `delivery.${setting}: expected an http or https address`;
    }
    case 'topic': {
      return 'delivery.topic: expected 1 to 64 letters, digits, hyphens, or underscores';
    }
    case 'token': {
      return 'delivery.token: expected a non-empty string';
    }
    default: {
      return `delivery.${String(setting)}: invalid`;
    }
  }
};

// The `[delivery]` section, or undefined when there is none, which turns
// delivery off. An invalid section throws an error that names the setting and
// never its value, since the topic or the token may be the secret.
export const parseDeliveryChannel = (value: unknown): DeliveryChannel | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = section.safeParse(value);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map(describeIssue).join('; '));
  }
  return parsed.data;
};

export const readDeliveryChannel = async ({
  cwd,
  home,
  named,
}: {
  cwd: string;
  home: string;
  named: string | undefined;
}) =>
  parseDeliveryChannel(
    await readConfigSection({
      binary: 'hub',
      cwd,
      home,
      named,
      section: 'delivery',
    }),
  );

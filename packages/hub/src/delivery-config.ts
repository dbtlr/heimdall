import { z } from 'zod';

import { describeIssue } from './config-issue.ts';

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

// What one setting should hold, given what is wrong with it; config-issue.ts
// names the key, never the value.
const expectation = (issue: z.core.$ZodIssue): string | undefined => {
  switch (issue.path[0]) {
    case 'dashboard':
    case 'url': {
      return 'expected an http or https address';
    }
    case 'topic': {
      return 'expected 1 to 64 letters, digits, hyphens, or underscores';
    }
    case 'token': {
      return 'expected a non-empty string';
    }
    default: {
      return undefined;
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
    throw new Error(
      parsed.error.issues.map((issue) => describeIssue('delivery', issue, expectation)).join('; '),
    );
  }
  return parsed.data;
};

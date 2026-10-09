import { configInput } from '@loomcli/plugins/config/extension';
import { text, url } from '@loomcli/validators';

// The Hub's base URL, from its flag, then its variable, then the top-level
// `hub` key, which holds no secret and is the same on every System.
export const hub = {
  description: 'Base URL of the Hub.',
  env: 'HEIMDALL_HUB',
  extensions: [configInput({ path: 'hub' })],
  required: true,
  type: 'string',
  validate: url({ protocols: ['http', 'https'] }),
} as const;

// Where the queue, the identity, and the records live, read the same way.
export const stateDir = {
  description:
    'Directory for the sample queue, the transcript spool, the records, and the identity. Defaults to the per-user state directory.',
  env: 'HEIMDALL_STATE_DIR',
  extensions: [configInput({ path: 'stateDir' })],
  type: 'string',
  validate: text(),
} as const;

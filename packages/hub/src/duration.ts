import { createValidator } from '@loomcli/validators';

const MINUTE = 60_000;
// The longest silence, so a typo cannot hold delivery for years or overflow a date.
export const MAX_DURATION_MS = 365 * 24 * 60 * MINUTE;
// Days, then hours, then minutes, each at most once and at least one present.
const DURATION = /^(?:(?<d>[0-9]+)d)?(?:(?<h>[0-9]+)h)?(?:(?<m>[0-9]+)m)?$/u;

// The milliseconds a duration such as 30m, 2h, 1d, or 1h30m spells: whole
// counts of days, hours, and minutes, in that order, summing to more than
// nothing and to at most 365 days. Answers undefined for anything else.
export const parseDuration = (text: string): number | undefined => {
  const { d = '0', h = '0', m = '0' } = DURATION.exec(text)?.groups ?? {};
  const total = ((Number(d) * 24 + Number(h)) * 60 + Number(m)) * MINUTE;
  return text !== '' && total > 0 && total <= MAX_DURATION_MS ? total : undefined;
};

// A Loom validator for a duration option. It keeps the token, as `date()` does,
// so the action reads it with `parseDuration`.
export const duration = () =>
  createValidator({
    parse: (raw) =>
      parseDuration(raw) === undefined
        ? {
            issues: [
              { message: 'Use a duration of up to 365 days, such as 30m, 2h, 1d, or 1h30m.' },
            ],
          }
        : { value: raw },
  });

// URL filter params arrive as one value or an array; keep the distinct strings.
// The router parses a lone numeric System name into a number, so that becomes a string.
export const stringList = (value: unknown): string[] => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return [String(value)];
  }
  if (typeof value === 'string') {
    return [value];
  }
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item) => typeof item === 'string' || typeof item === 'number')
            .flatMap(stringList),
        ),
      ]
    : [];
};

// A param's validated values, or undefined so an empty filter leaves the URL bare.
export const knownValues = <T extends string>(
  value: unknown,
  known: readonly T[],
): T[] | undefined => {
  const values = stringList(value).filter((item): item is T => known.some((one) => one === item));
  return values.length > 0 ? values : undefined;
};

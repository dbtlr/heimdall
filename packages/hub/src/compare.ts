// Orders text by UTF-16 code unit, the same in every locale, so lists the Hub
// serves and judges in order do not depend on the machine's locale.
export const compareCodeUnits = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

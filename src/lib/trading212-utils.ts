/**
 * Strip Trading212's exchange/suffix segments from a ticker.
 * Loops the regex so multi-segment suffixes like `_US_EQ` or `_ABC_EQ` are
 * fully stripped: `AAPL_US_EQ` -> `AAPL`, `XYZ_ABC_EQ` -> `XYZ`.
 */
export function stripT212Suffix(ticker: string): string {
  let out = ticker;
  const re = /_[A-Z]{2,4}$/;
  while (re.test(out)) {
    out = out.replace(re, "");
  }
  return out;
}

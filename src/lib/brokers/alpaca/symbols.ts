/**
 * Alpaca-specific symbol normalization. Alpaca returns clean US tickers
 * like `AAPL`, `MSFT`, `BRK.B`. The only translation needed is the
 * class-share dot-to-dash for Yahoo Finance compatibility:
 *
 *   Alpaca:  BRK.B   →   Yahoo:  BRK-B
 *   Alpaca:  BF.B    →   Yahoo:  BF-B
 *
 * This is safe to apply unconditionally for `asset_class === "us_equity"`.
 * Non-equity Alpaca symbols (crypto pairs like `BTC/USD`, options) are
 * filtered out upstream in sync.ts and never reach this function.
 */

export function alpacaSymbolToYahoo(symbol: string): string {
  return symbol.replace(/\./g, "-");
}

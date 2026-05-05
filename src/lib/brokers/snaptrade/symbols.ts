/**
 * SnapTrade-specific symbol normalization. SnapTrade returns broker-
 * native symbols which for US equities are usually clean. The only
 * routine transformation is class-share dot-to-dash for Yahoo
 * compatibility (`BRK.B` → `BRK-B`), same as Alpaca.
 *
 * Non-equity symbols (crypto pairs, options) are filtered out
 * upstream in sync.ts and never reach this function.
 */

export function snaptradeSymbolToYahoo(symbol: string): string {
  return symbol.replace(/\./g, "-");
}

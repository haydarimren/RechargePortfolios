import { afterEach, describe, it, expect, vi } from "vitest";
import {
  mapSnaptradeActivity,
  listSnapTradeAccounts,
  type SnaptradeActivity,
} from "./sync";
import { snaptradeAdapter } from "./index";

vi.mock("../../firebase", () => ({
  auth: { currentUser: { getIdToken: async () => "fake-id-token" } },
}));

function activity(overrides: Partial<SnaptradeActivity> = {}): SnaptradeActivity {
  return {
    id: "act-1",
    trade_date: "2024-06-15T14:30:00Z",
    type: "BUY",
    units: 10,
    price: 150.5,
    symbol: { symbol: { symbol: "AAPL" } },
    currency: { code: "USD" },
    ...overrides,
  };
}

describe("mapSnaptradeActivity", () => {
  it("keeps a BUY", () => {
    const r = mapSnaptradeActivity(activity());
    expect(r.kind).toBe("keep");
    if (r.kind !== "keep") return;
    expect(r.order).toEqual({
      id: "act-1",
      symbol: "AAPL",
      shares: 10,
      purchasePrice: 150.5,
      purchaseDate: "2024-06-15",
      currency: "USD",
      yahooSymbol: "AAPL",
      side: "BUY",
    });
  });

  it("keeps a SELL", () => {
    const r = mapSnaptradeActivity(activity({ type: "SELL" }));
    if (r.kind !== "keep") throw new Error("expected keep");
    expect(r.order.side).toBe("SELL");
  });

  it("normalizes class-share dot to dash", () => {
    const r = mapSnaptradeActivity(
      activity({ symbol: { symbol: { symbol: "BRK.B" } } }),
    );
    if (r.kind !== "keep") throw new Error("expected keep");
    expect(r.order.symbol).toBe("BRK-B");
    expect(r.order.yahooSymbol).toBe("BRK-B");
  });

  it("treats SELL units as positive (uses abs)", () => {
    const r = mapSnaptradeActivity(activity({ type: "SELL", units: -5 }));
    if (r.kind !== "keep") throw new Error("expected keep");
    expect(r.order.shares).toBe(5);
    expect(r.order.side).toBe("SELL");
  });

  it("skips non-trade activity types", () => {
    expect(mapSnaptradeActivity(activity({ type: "DIVIDEND" })).kind).toBe("skip");
    expect(mapSnaptradeActivity(activity({ type: "FEE" })).kind).toBe("skip");
    expect(mapSnaptradeActivity(activity({ type: "CASH_TRANSFER" })).kind).toBe("skip");
    expect(mapSnaptradeActivity(activity({ type: "STOCK_SPLIT" })).kind).toBe("skip");
  });

  it("skips activities missing trade_date", () => {
    expect(mapSnaptradeActivity(activity({ trade_date: null })).kind).toBe("skip");
  });

  it("skips activities missing units or price", () => {
    expect(mapSnaptradeActivity(activity({ units: null })).kind).toBe("skip");
    expect(mapSnaptradeActivity(activity({ price: null })).kind).toBe("skip");
  });

  it("skips activities with non-positive shares or price", () => {
    expect(mapSnaptradeActivity(activity({ units: 0 })).kind).toBe("skip");
    expect(mapSnaptradeActivity(activity({ price: 0 })).kind).toBe("skip");
    expect(mapSnaptradeActivity(activity({ price: -1 })).kind).toBe("skip");
  });

  it("skips activities missing a symbol", () => {
    expect(mapSnaptradeActivity(activity({ symbol: null })).kind).toBe("skip");
    expect(
      mapSnaptradeActivity(activity({ symbol: { symbol: null } })).kind,
    ).toBe("skip");
    expect(
      mapSnaptradeActivity(
        activity({ symbol: { symbol: { symbol: "" } } }),
      ).kind,
    ).toBe("skip");
  });

  it("preserves currency from the activity record", () => {
    const r = mapSnaptradeActivity(
      activity({ currency: { code: "CAD" } }),
    );
    if (r.kind !== "keep") throw new Error("expected keep");
    expect(r.order.currency).toBe("CAD");
  });

  it("leaves currency undefined when SnapTrade omits it", () => {
    // SnapTrade has been observed to send `currency: null` for some
    // brokerages. We pass through as `undefined` (the field is
    // optional on Holding); downstream UI shows "—".
    const rNullCurrency = mapSnaptradeActivity(
      activity({ currency: null }),
    );
    if (rNullCurrency.kind !== "keep") throw new Error("expected keep");
    expect(rNullCurrency.order.currency).toBeUndefined();

    const rEmptyCurrency = mapSnaptradeActivity(
      activity({ currency: {} }),
    );
    if (rEmptyCurrency.kind !== "keep") throw new Error("expected keep");
    expect(rEmptyCurrency.order.currency).toBeUndefined();
  });

  it("strips time portion off ISO trade_date", () => {
    const r = mapSnaptradeActivity(
      activity({ trade_date: "2024-12-31T23:59:59.999Z" }),
    );
    if (r.kind !== "keep") throw new Error("expected keep");
    expect(r.order.purchaseDate).toBe("2024-12-31");
  });
});

describe("snaptradeAdapter", () => {
  it("declares the four BYO credential fields", () => {
    // BYO model: end user pastes clientId, consumerKey, userId,
    // userSecret from their own SnapTrade developer dashboard. If
    // any field is added/removed/renamed here, the connect form +
    // server auth builder must change in lockstep.
    expect(snaptradeAdapter.credentialFields.map((f) => f.id)).toEqual([
      "clientId",
      "consumerKey",
      "snaptradeUserId",
      "snaptradeUserSecret",
    ]);
  });

  it("displayName is the user-facing label", () => {
    expect(snaptradeAdapter.displayName).toBe("SnapTrade");
  });

  it("buildCredential packs the four form values as JSON (no accountId)", () => {
    // The accountId comes later, after the user picks one from
    // the picker. buildCredential is called BEFORE the picker.
    const json = snaptradeAdapter.buildCredential({
      clientId: " CLIENT ",
      consumerKey: " KEY ",
      snaptradeUserId: " uid ",
      snaptradeUserSecret: " secret ",
    });
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      clientId: "CLIENT",
      consumerKey: "KEY",
      snaptradeUserId: "uid",
      snaptradeUserSecret: "secret",
    });
    expect(parsed.snaptradeAccountId).toBeUndefined();
  });
});

describe("listSnapTradeAccounts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const validCred = JSON.stringify({
    clientId: "C",
    consumerKey: "K",
    snaptradeUserId: "u",
    snaptradeUserSecret: "s",
  });

  it("rejects malformed credentials before issuing any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(listSnapTradeAccounts("not-json")).rejects.toThrow(
      /not valid JSON/,
    );
    await expect(listSnapTradeAccounts("{}")).rejects.toThrow(
      /missing required fields/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls /api/v1/snapTrade/listUserAccounts with userId+userSecret in query", async () => {
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("[]", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await listSnapTradeAccounts(validCred);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.brokerId).toBe("snaptrade");
    expect(body.path).toBe(
      "/api/v1/snapTrade/listUserAccounts?userId=u&userSecret=s",
    );
    expect(body.method).toBe("GET");
    // Auth payload handed to the proxy contains exactly the 4 BYO
    // fields — no accountId (that's URL routing, not auth). If
    // accountId ever leaks into the auth blob, the proxy's structural
    // check would still pass but the contract would silently drift.
    const authPayload = JSON.parse(body.auth);
    expect(Object.keys(authPayload).sort()).toEqual([
      "clientId",
      "consumerKey",
      "snaptradeUserId",
      "snaptradeUserSecret",
    ]);
  });

  it("maps SnapTrade account responses into our SnapTradeAccountSummary shape", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify([
          {
            id: "acc-1",
            name: "Roth IRA",
            institution_name: "Fidelity",
            number: "***1234",
          },
          {
            id: "acc-2",
            // No `name` — should fall back to institution_name.
            institution_name: "Schwab",
          },
          {
            // No `id` — should be filtered out.
            name: "Orphan account",
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await listSnapTradeAccounts(validCred);
    expect(result).toEqual([
      {
        id: "acc-1",
        name: "Roth IRA",
        brokerage: "Fidelity",
        number: "***1234",
      },
      { id: "acc-2", name: "Schwab", brokerage: "Schwab", number: undefined },
    ]);
  });

  it("propagates non-OK responses as errors", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response("forbidden", { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(listSnapTradeAccounts(validCred)).rejects.toThrow(/403/);
  });
});

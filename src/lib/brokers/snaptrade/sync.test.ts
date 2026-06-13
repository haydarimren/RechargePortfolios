import { afterEach, describe, it, expect, vi } from "vitest";
import {
  mapSnaptradeActivity,
  mapSnaptradeOrder,
  mapSnaptradePosition,
  fetchSnapTradeOrders,
  listSnapTradeAccounts,
  parseSnaptradeAccountIds,
  type SnaptradeActivity,
  type SnaptradeOrder,
  type SnaptradePosition,
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

function order(overrides: Partial<SnaptradeOrder> = {}): SnaptradeOrder {
  return {
    brokerage_order_id: "oid-1",
    status: "EXECUTED",
    action: "BUY",
    filled_quantity: "10",
    execution_price: 100,
    time_executed: "2026-05-15T14:30:00Z",
    universal_symbol: { symbol: "AAPL" },
    quote_currency: { code: "USD" },
    ...overrides,
  };
}

describe("mapSnaptradeOrder skip reasons", () => {
  const reason = (o: SnaptradeOrder) => {
    const r = mapSnaptradeOrder(o);
    return r.kind === "skip" ? r.reason : "keep";
  };
  it("keeps a valid order", () => {
    expect(mapSnaptradeOrder(order()).kind).toBe("keep");
  });
  it("flags every guard with the matching reason", () => {
    expect(reason(order({ action: "DIVIDEND" }))).toBe("unsupported-action");
    expect(reason(order({ brokerage_order_id: undefined }))).toBe("no-order-id");
    expect(reason(order({ time_executed: null }))).toBe("no-time-executed");
    expect(reason(order({ execution_price: null }))).toBe("no-execution-price");
    expect(reason(order({ filled_quantity: null }))).toBe("no-filled-qty");
    expect(reason(order({ universal_symbol: { symbol: "" } }))).toBe(
      "no-symbol",
    );
    expect(reason(order({ filled_quantity: "abc" }))).toBe("non-finite-shares");
    expect(reason(order({ execution_price: -1 }))).toBe("non-positive-price");
  });
});

describe("mapSnaptradePosition skip reasons", () => {
  const base: SnaptradePosition = {
    units: 5,
    average_purchase_price: 10,
    symbol: { symbol: { symbol: "AAPL" } },
    currency: { code: "USD" },
  };
  const reason = (p: SnaptradePosition) => {
    const r = mapSnaptradePosition(p, "acc", "2026-05-18");
    return r.kind === "skip" ? r.reason : "keep";
  };
  it("flags each guard", () => {
    expect(reason({ ...base, symbol: null })).toBe("no-symbol");
    expect(reason({ ...base, units: 0 })).toBe("non-positive-units");
    expect(
      reason({ ...base, average_purchase_price: 0, price: 0 }),
    ).toBe("non-positive-price");
    expect(reason(base)).toBe("keep");
  });
});

describe("fetchSnapTradeOrders diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const cred = JSON.stringify({
    clientId: "C",
    consumerKey: "K",
    snaptradeUserId: "u",
    snaptradeUserSecret: "s",
    snaptradeAccountId: "ACCT-ZZSECRET",
  });

  function stubHoldings(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
  }

  it("records a decision per record with skip reasons + qty sign", async () => {
    stubHoldings({
      orders: [
        order(), // kept BUY
        order({ action: "DIVIDEND", brokerage_order_id: "oid-div" }), // skipped
        order({
          brokerage_order_id: "oid-neg",
          action: "BUY",
          filled_quantity: "-7", // sign signal for the mis-sided-sell bug
          universal_symbol: { symbol: "TSLA" },
        }),
      ],
      positions: [
        // Same symbol as a kept order → suppressed-by-orders.
        {
          units: 10,
          average_purchase_price: 100,
          symbol: { symbol: { symbol: "AAPL" } },
        },
        // Distinct symbol with no order → kept.
        {
          units: 3,
          average_purchase_price: 50,
          symbol: { symbol: { symbol: "MSFT" } },
        },
      ],
    });

    const res = await fetchSnapTradeOrders(cred);
    const d = res.diagnostics;
    expect(d).toBeDefined();
    if (!d) return;

    expect(d.rawOrderCount).toBe(3);
    expect(d.rawPositionCount).toBe(2);

    const byTokenDecision = d.orders.map((o) => o.decision);
    expect(byTokenDecision).toContain("kept");
    expect(byTokenDecision).toContain("skipped");

    const div = d.orders.find((o) => o.action === "DIVIDEND");
    expect(div?.decision).toBe("skipped");
    expect(div?.skipReason).toBe("unsupported-action");

    const neg = d.orders.find((o) => o.filledQtySign === "negative");
    expect(neg).toBeDefined();
    expect(neg?.rawKeys).toContain("filled_quantity");

    const suppressed = d.positions.find(
      (p) => p.decision === "suppressed-by-orders",
    );
    expect(suppressed).toBeDefined();
    expect(d.positions.some((p) => p.decision === "kept")).toBe(true);
    expect(d.summary.positionsSuppressed).toBe(1);
    expect(d.summary.ordersSkipped["unsupported-action"]).toBe(1);
  });

  it("marks an order deduped (not kept) when isOrderKnown matches", async () => {
    stubHoldings({ orders: [order({ brokerage_order_id: "known-1" })], positions: [] });
    const res = await fetchSnapTradeOrders(cred, (a) => a.orderId === "known-1");
    expect(res.orders).toHaveLength(0);
    expect(res.diagnostics?.orders[0].decision).toBe("deduped");
    expect(res.diagnostics?.summary.ordersDeduped).toBe(1);
  });

  it("redacts: trace contains no symbols, magnitudes, prices, ids", async () => {
    stubHoldings({
      orders: [
        order({
          brokerage_order_id: "OID-ZZSECRET",
          filled_quantity: "777.7777",
          execution_price: 4242.42,
          universal_symbol: { symbol: "ZZSECRETSYMZZ" },
        }),
      ],
      positions: [
        {
          units: 88.88,
          average_purchase_price: 1313.13,
          symbol: { symbol: { symbol: "ZZSECRETSYMZZ" } },
        },
      ],
    });
    const res = await fetchSnapTradeOrders(cred);
    const blob = JSON.stringify(res.diagnostics);
    for (const sentinel of [
      "ZZSECRETSYM",
      "777.777",
      "4242",
      "OID-ZZSECRET",
      "ACCT-ZZSECRET",
      "88.88",
      "1313.13",
    ]) {
      expect(blob).not.toContain(sentinel);
    }
    // The redacted token IS present (correlation without identity).
    expect(blob).toContain("SYM_1");
  });
});

describe("fetchSnapTradeOrders reconciliation (positions authoritative)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const cred = JSON.stringify({
    clientId: "C",
    consumerKey: "K",
    snaptradeUserId: "u",
    snaptradeUserSecret: "s",
    snaptradeAccountId: "ACC",
  });

  function stubHoldings(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
  }

  const posFor = (
    positions: { symbol: string; units: number; price: number }[] | undefined,
    sym: string,
  ) => (positions ?? []).find((p) => p.symbol === sym);

  it("surfaces the broker position as authoritative units, even on an incomplete window", async () => {
    // Window has only the BUY; the offsetting SELL aged out. Broker
    // says he now holds 40. The adapter must NOT turn this into a lot
    // or net the orders — it surfaces the position for the page to
    // reconcile against stored holdings.
    stubHoldings({
      orders: [
        order({
          brokerage_order_id: "b1",
          action: "BUY",
          filled_quantity: "100",
          universal_symbol: { symbol: "REC" },
        }),
      ],
      positions: [
        {
          units: 40,
          average_purchase_price: 50,
          symbol: { symbol: { symbol: "REC" } },
        },
      ],
    });
    const res = await fetchSnapTradeOrders(cred);
    expect(posFor(res.positions, "REC")).toEqual({
      symbol: "REC",
      units: 40,
      price: 50,
      currency: undefined,
      yahooSymbol: "REC",
    });
    // The real BUY leg still flows through for the timeline...
    expect(res.orders.filter((o) => o.symbol === "REC")).toHaveLength(1);
    // ...but no synthetic/reconciler lot is emitted by the adapter.
    expect(res.orders.some((o) => o.id.startsWith("pos-"))).toBe(false);
  });

  it("surfaces the position even when orders already reconcile", async () => {
    stubHoldings({
      orders: [
        order({
          brokerage_order_id: "b1",
          action: "BUY",
          filled_quantity: "100",
          universal_symbol: { symbol: "REC" },
        }),
        order({
          brokerage_order_id: "s1",
          action: "SELL",
          filled_quantity: "60",
          universal_symbol: { symbol: "REC" },
        }),
      ],
      positions: [
        {
          units: 40,
          average_purchase_price: 50,
          symbol: { symbol: { symbol: "REC" } },
        },
      ],
    });
    const res = await fetchSnapTradeOrders(cred);
    expect(posFor(res.positions, "REC")?.units).toBe(40);
    expect(res.orders.filter((o) => o.symbol === "REC")).toHaveLength(2);
    expect(res.orders.some((o) => o.id.startsWith("pos-"))).toBe(false);
  });

  it("surfaces a position that has no order history at all", async () => {
    stubHoldings({
      orders: [],
      positions: [
        {
          units: 7,
          average_purchase_price: 12,
          symbol: { symbol: { symbol: "NOORD" } },
        },
      ],
    });
    const res = await fetchSnapTradeOrders(cred);
    expect(posFor(res.positions, "NOORD")).toMatchObject({
      symbol: "NOORD",
      units: 7,
      price: 12,
    });
    expect(res.orders).toHaveLength(0);
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

  it("calls /api/v1/accounts with userId+userSecret in query", async () => {
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
      "/api/v1/accounts?userId=u&userSecret=s",
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

describe("fetchSnapTradeOrders multi-account", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const multiCred = JSON.stringify({
    clientId: "C",
    consumerKey: "K",
    snaptradeUserId: "u",
    snaptradeUserSecret: "s",
    snaptradeAccountIds: ["ACC-ONE-SECRET", "ACC-TWO-SECRET"],
  });

  /** Route the proxy fetch by which account's holdings path is requested. */
  function stubPerAccount(
    bodies: Record<string, unknown>,
    failFor?: { accountId: string; status: number },
  ) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const req = JSON.parse((init?.body as string) ?? "{}");
        const path: string = req.path ?? "";
        if (failFor && path.includes(`/accounts/${encodeURIComponent(failFor.accountId)}/holdings`)) {
          return new Response("boom", { status: failFor.status });
        }
        const accountId = Object.keys(bodies).find((id) =>
          path.includes(`/accounts/${encodeURIComponent(id)}/holdings`),
        );
        if (!accountId) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(bodies[accountId]), { status: 200 });
      }),
    );
  }

  it("fetches every account and tags each order leg with its source account", async () => {
    stubPerAccount({
      "ACC-ONE-SECRET": {
        orders: [order({ brokerage_order_id: "o1", universal_symbol: { symbol: "AAPL" } })],
        positions: [],
      },
      "ACC-TWO-SECRET": {
        orders: [order({ brokerage_order_id: "o2", universal_symbol: { symbol: "MSFT" } })],
        positions: [],
      },
    });
    const res = await fetchSnapTradeOrders(multiCred);
    expect(res.orders).toHaveLength(2);
    expect(res.orders.find((o) => o.id === "o1")?.snaptradeAccountId).toBe("ACC-ONE-SECRET");
    expect(res.orders.find((o) => o.id === "o2")?.snaptradeAccountId).toBe("ACC-TWO-SECRET");
  });

  it("merges same-symbol positions across accounts: summed units, unit-weighted price", async () => {
    stubPerAccount({
      "ACC-ONE-SECRET": {
        orders: [],
        positions: [{ units: 40, average_purchase_price: 50, symbol: { symbol: { symbol: "REC" } } }],
      },
      "ACC-TWO-SECRET": {
        orders: [],
        positions: [
          { units: 10, average_purchase_price: 100, symbol: { symbol: { symbol: "REC" } } },
          { units: 3, average_purchase_price: 12, symbol: { symbol: { symbol: "ONLY2" } } },
        ],
      },
    });
    const res = await fetchSnapTradeOrders(multiCred);
    const rec = (res.positions ?? []).find((p) => p.symbol === "REC");
    expect(rec?.units).toBe(50);
    expect(rec?.price).toBeCloseTo((40 * 50 + 10 * 100) / 50, 6); // 60
    expect((res.positions ?? []).find((p) => p.symbol === "ONLY2")?.units).toBe(3);
  });

  it("is all-or-nothing: any account failing aborts the whole sync", async () => {
    stubPerAccount(
      {
        "ACC-ONE-SECRET": { orders: [order()], positions: [] },
        "ACC-TWO-SECRET": { orders: [], positions: [] },
      },
      { accountId: "ACC-TWO-SECRET", status: 500 },
    );
    await expect(fetchSnapTradeOrders(multiCred)).rejects.toThrow(/account 2 of 2/);
  });

  it("lifts a legacy single-account credential to a one-element set", async () => {
    const legacy = JSON.stringify({
      clientId: "C",
      consumerKey: "K",
      snaptradeUserId: "u",
      snaptradeUserSecret: "s",
      snaptradeAccountId: "ACC-ONE-SECRET",
    });
    stubPerAccount({ "ACC-ONE-SECRET": { orders: [order()], positions: [] } });
    const res = await fetchSnapTradeOrders(legacy);
    expect(res.orders).toHaveLength(1);
    expect(res.orders[0].snaptradeAccountId).toBe("ACC-ONE-SECRET");
  });

  it("parseSnaptradeAccountIds: plural, legacy lift, garbage → []", () => {
    expect(
      parseSnaptradeAccountIds(JSON.stringify({ snaptradeAccountIds: ["a", "b"] })),
    ).toEqual(["a", "b"]);
    expect(
      parseSnaptradeAccountIds(JSON.stringify({ snaptradeAccountId: "solo" })),
    ).toEqual(["solo"]);
    expect(parseSnaptradeAccountIds("not-json")).toEqual([]);
    expect(parseSnaptradeAccountIds(JSON.stringify({}))).toEqual([]);
    expect(
      parseSnaptradeAccountIds(JSON.stringify({ snaptradeAccountIds: ["", 3, "x"] })),
    ).toEqual(["x"]);
  });

  it("rejects a credential with an empty account set", async () => {
    const empty = JSON.stringify({
      clientId: "C",
      consumerKey: "K",
      snaptradeUserId: "u",
      snaptradeUserSecret: "s",
      snaptradeAccountIds: [],
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(fetchSnapTradeOrders(empty)).rejects.toThrow(/account/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("diagnostics: opaque ACC tokens, no raw account ids, schemaVersion 2", async () => {
    stubPerAccount({
      "ACC-ONE-SECRET": {
        orders: [order({ universal_symbol: { symbol: "ZZSECRETSYMZZ" } })],
        positions: [],
      },
      "ACC-TWO-SECRET": {
        orders: [],
        positions: [{ units: 5, average_purchase_price: 10, symbol: { symbol: { symbol: "ZZSECRETSYMZZ" } } }],
      },
    });
    const res = await fetchSnapTradeOrders(multiCred);
    const d = res.diagnostics;
    expect(d?.schemaVersion).toBe(2);
    expect(d?.orders[0].accountToken).toBe("ACC_1");
    expect(d?.positions[0].accountToken).toBe("ACC_2");
    const blob = JSON.stringify(d);
    expect(blob).not.toContain("ACC-ONE-SECRET");
    expect(blob).not.toContain("ACC-TWO-SECRET");
    expect(blob).not.toContain("ZZSECRETSYM");
  });
});

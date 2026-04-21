export interface Portfolio {
  id: string;
  ownerId: string;
  ownerEmail: string;
  name: string;
  sharedWith: string[];
  createdAt: number;
  brokerKeys?: Record<string, string>;
}

export interface Holding {
  id: string;
  symbol: string;
  shares: number;
  purchasePrice: number;
  purchaseDate: string;
  createdAt: number;
  importSource?: string;
  currency?: string;
  t212OrderId?: string;
  /**
   * Transaction side. `undefined` is treated as "BUY" so pre-existing
   * Firestore docs (which predate sell support) keep working without migration.
   */
  side?: "BUY" | "SELL";
}

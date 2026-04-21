"use server";

/**
 * Finnhub API Wrapper for fetching historical benchmark data.
 */

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';

export interface StockQuote {
  c: number; // Current price
  d: number; // Change
  dp: number; // Percent change
  h: number; // High price of the day
  l: number; // Low price of the day
  o: number; // Open price of the day
  pc: number; // Previous close price
}

export async function getQuote(symbol: string): Promise<StockQuote | null> {
  const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
  
  if (!FINNHUB_API_KEY) {
    console.warn("Missing FINNHUB_API_KEY. Using mock data.");
    return generateMockQuote(symbol);
  }

  try {
    const res = await fetch(`${FINNHUB_BASE_URL}/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`, {
      next: { revalidate: 3600 } // cache for 1 hour to avoid rate hitting
    });
    
    if (!res.ok) throw new Error(`Finnhub error: ${res.statusText}`);
    
    const data = await res.json();
    return data as StockQuote;
  } catch (error) {
    console.error("Failed to fetch quote from Finnhub", error);
    return null;
  }
}

// Generate some mock data so UI doesn't break when missing key
function generateMockQuote(symbol: string): StockQuote {
  const base = symbol === 'SPY' ? 510 : symbol === 'QQQ' ? 440 : 100;
  return {
    c: base + (Math.random() * 5 - 2.5),
    d: 1.5,
    dp: 0.3,
    h: base + 2,
    l: base - 2,
    o: base,
    pc: base - 1.5
  };
}

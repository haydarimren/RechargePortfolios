"use client";

/**
 * Shared client-side helper for calling the broker-agnostic proxy at
 * `/api/broker-proxy`. Each adapter funnels its HTTP calls through this
 * helper so the wire format stays consistent.
 *
 * Concurrency control and broker-specific retry policies (e.g. T212's
 * 65s sleep on 429) live inside each adapter, NOT in this module — Alpaca
 * and other brokers have very different rate-limit characteristics from
 * T212 and shouldn't pay for serial-queue overhead they don't need.
 */

import { auth } from "../firebase";
import type { BrokerId } from "./types";

export interface ProxyFetchOptions {
  /**
   * HTTP method for the upstream request. The proxy still enforces
   * per-broker `methods` allowlist; this just communicates intent.
   */
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * Body for non-GET methods. Forwarded verbatim to the upstream. The
   * server-side auth builder also sees this so HMAC signers can sign
   * over it. Pass a JSON-stringified string for JSON bodies.
   */
  body?: string;
}

/**
 * Issue a single proxy call. The proxy validates the bearer token, looks
 * up `brokerId` in its server-side registry, and forwards the request to
 * the broker's API host with the appropriate auth headers (built from
 * `credential`).
 *
 * Returns the raw `Response` so callers can inspect status / parse the
 * body themselves.
 */
export async function proxyFetch(
  brokerId: BrokerId,
  credential: string,
  path: string,
  opts: ProxyFetchOptions = {},
): Promise<Response> {
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error("not signed in");
  const method = opts.method ?? "GET";
  return fetch("/api/broker-proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      brokerId,
      auth: credential,
      path,
      method,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    }),
    cache: "no-store",
  });
}

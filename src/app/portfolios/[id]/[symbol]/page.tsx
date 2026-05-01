"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LegacyTickerRedirect({
  params,
}: {
  params: Promise<{ id: string; symbol: string }>;
}) {
  const { id, symbol } = use(params);
  const router = useRouter();
  useEffect(() => {
    router.replace(`/p/${id}/${symbol}`);
  }, [router, id, symbol]);
  return null;
}

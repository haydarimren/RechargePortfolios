"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LegacyPortfolioRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  useEffect(() => {
    router.replace(`/p/${id}`);
  }, [router, id]);
  return null;
}

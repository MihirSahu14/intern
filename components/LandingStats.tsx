"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export default function LandingStats() {
  const s = useQuery(api.community.landing, {});
  if (!s) return null;
  const n = (x: number) => (x >= s.cap ? `${s.cap}+` : String(x));
  return (
    <p className="mt-4 text-faint">
      {n(s.people)} people have tried it · {n(s.facts)} facts · {n(s.approved)} drafts approved
    </p>
  );
}

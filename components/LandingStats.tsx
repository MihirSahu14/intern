"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { plural } from "@/lib/plural";

export default function LandingStats() {
  const s = useQuery(api.community.landing, {});
  if (!s) return null;
  // Pluralize off the real count, but show the capped "N+" label once past the cap.
  const capped = (x: number, singular: string, pluralForm?: string) =>
    plural(x, singular, pluralForm).replace(/^\d+/, x >= s.cap ? `${s.cap}+` : String(x));
  return (
    <p className="mt-4 text-faint">
      {capped(s.people, "person", "people")} {s.people === 1 ? "has" : "have"} tried it ·{" "}
      {capped(s.facts, "fact")} · {capped(s.approved, "draft")} approved
    </p>
  );
}

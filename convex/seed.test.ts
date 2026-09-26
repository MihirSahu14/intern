/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("refresh patches a changed seed fact's body and text back to SEED, then is a no-op", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.seed.run, {});

  const row = await t.run((ctx) =>
    ctx.db.query("facts").withIndex("by_ownerId", (q) => q.eq("ownerId", undefined)).filter((q) => q.eq(q.field("title"), "What Intern is")).first(),
  );
  expect(row).not.toBeNull();
  const original = row!.body;

  // Simulate a stale prod row: the old "next step" sentence still in place.
  await t.run((ctx) => ctx.db.patch(row!._id, { body: "stale body", text: "What Intern is\nstale body" }));

  const first = await t.mutation(internal.seed.refresh, {});
  expect(first.updated).toBe(1);

  const patched = await t.run((ctx) => ctx.db.get(row!._id));
  expect(patched!.body).toBe(original);
  expect(patched!.text).toBe(`What Intern is\n${original}`);

  const second = await t.mutation(internal.seed.refresh, {});
  expect(second.updated).toBe(0);
});

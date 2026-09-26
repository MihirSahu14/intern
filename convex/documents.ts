"use node";

import { v } from "convex/values";
import {
  IngestError,
  NO_TEXT_LAYER,
  UPLOAD_MAX_BYTES,
  chunk,
  decodeText,
  fetchDocument,
  hasTextLayer,
  htmlToText,
  isPdf,
  sourceError,
} from "../lib/ingest.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";

/**
 * Documents members add, read in Node: its fetch hands back a redirect's real
 * 3xx under `redirect: "manual"`, which fetchDocument's per-hop address check
 * depends on, and pdf.js runs here. No model calls.
 */

async function save(ctx: ActionCtx, sourceId: Id<"sources">, text: string, label?: string, url?: string) {
  const chunks = chunk(text);
  if (!chunks.length) throw new IngestError("There's no text in that to read.");
  const at = Date.now();
  await ctx.runMutation(internal.sources.write, {
    sourceId,
    label,
    passages: chunks.map((c, i) => ({ externalId: String(i), text: c, url, at })),
    synced: true,
  });
}

async function failed(ctx: ActionCtx, sourceId: Id<"sources">, err: unknown) {
  if (!(err instanceof IngestError)) console.log(`documents: ${sourceId} failed: ${err instanceof Error ? err.message : String(err)}`);
  await ctx.runMutation(internal.sources.fail, { sourceId, error: sourceError(err) });
}

export const readUrl = internalAction({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const src: Doc<"sources"> | null = await ctx.runQuery(internal.sources.get, { sourceId });
    if (!src?.url || src.status === "removed") return null;
    try {
      const page = await fetchDocument(src.url);
      const doc = page.contentType === "text/html" ? htmlToText(page.text) : { title: null, text: page.text };
      await save(ctx, sourceId, doc.text, doc.title ?? undefined, page.url);
    } catch (err) {
      await failed(ctx, sourceId, err);
    }
    return null;
  },
});

export const readUpload = internalAction({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const src: Doc<"sources"> | null = await ctx.runQuery(internal.sources.get, { sourceId });
    if (!src?.storageId || src.status === "removed") return null;
    try {
      const blob = await ctx.storage.get(src.storageId);
      if (!blob) throw new IngestError("That upload is gone. Upload it again.");
      if (blob.size > UPLOAD_MAX_BYTES) throw new IngestError(`Keep uploads under ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text: string;
      if (isPdf(bytes)) {
        // Loaded only for a PDF, so reading text never pays for pdf.js.
        const { pdfText } = await import("../lib/pdf.ts");
        try {
          text = await pdfText(bytes);
        } catch {
          throw new IngestError("That PDF couldn't be read.");
        }
        if (!hasTextLayer(text)) throw new IngestError(NO_TEXT_LAYER);
      } else {
        text = decodeText(bytes);
      }
      await save(ctx, sourceId, text);
    } catch (err) {
      await failed(ctx, sourceId, err);
    }
    return null;
  },
});

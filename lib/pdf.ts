import { getDocumentProxy } from "unpdf";
import { CHUNK_MAX, MAX_PASSAGES_PER_DOCUMENT } from "./ingest.ts";

/** Pages read at most. */
export const PDF_MAX_PAGES = 500;
/** Text kept at most: past this, the chunker has no room for any of it. */
export const PDF_MAX_CHARS = MAX_PASSAGES_PER_DOCUMENT * CHUNK_MAX;

/** The part of pdf.js's document the page loop reads. */
export type Pages = {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: object[] }> }>;
};

/**
 * Page by page, as unpdf's own extractText joins a page's items, stopping at
 * PDF_MAX_PAGES or once PDF_MAX_CHARS is read. Pages are separated by blank
 * lines so the chunker splits between them.
 */
export async function pagesText(pdf: Pages): Promise<string> {
  const pages: string[] = [];
  let chars = 0;
  for (let n = 1; n <= Math.min(pdf.numPages, PDF_MAX_PAGES) && chars < PDF_MAX_CHARS; n++) {
    const { items } = await (await pdf.getPage(n)).getTextContent();
    const text = items
      .map((i) => ("str" in i && typeof i.str === "string" ? i.str + ("hasEOL" in i && i.hasEOL ? "\n" : "") : ""))
      .join("");
    pages.push(text);
    chars += text.length;
  }
  return pages.join("\n\n");
}

/**
 * A PDF's text layer. unpdf is pdf.js's serverless build: pure JS, no native
 * dependencies; confirmed on 2026-09-25 (Task 6 Step 1). Its bundled pdf.js
 * has no `isEvalSupported` option and no eval to turn off. A scan comes back
 * empty; the caller refuses it.
 */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  return await pagesText(await getDocumentProxy(bytes));
}

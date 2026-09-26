import { extractText, getDocumentProxy } from "unpdf";

/**
 * A PDF's text layer, pages separated by blank lines so the chunker splits
 * between them. unpdf is pdf.js's serverless build: pure JS, no native
 * dependencies; confirmed on 2026-09-25 (Task 6 Step 1). A scan comes back
 * empty; the caller refuses it.
 */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return text.join("\n\n");
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { pdfText } from "./pdf.ts";

/** A one-page PDF whose page says `text` (nothing, for a scan), with a correct xref so pdf.js reads it without repair. */
function onePagePdf(text: string): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 20 50 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("a PDF's text layer is read", async () => {
  assert.match(await pdfText(onePagePdf("We ship on Fridays")), /We ship on Fridays/);
});

test("a page with no text layer reads as nothing", async () => {
  assert.equal((await pdfText(onePagePdf(""))).trim(), "");
});

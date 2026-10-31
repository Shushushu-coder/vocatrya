import { Document, Packer, Paragraph, TextRun } from "docx";
import { parseResumeHeaderSnapshot } from "./resumeHeaderSnapshot";
type Source = { headerSnapshot: string | null; sections: { title: string; hiddenAt?: Date | string | null; items: { materialTitleSnapshot?: string | null; hiddenAt?: Date | string | null; expressions: { kind: string; content: string; hiddenAt?: Date | string | null }[] }[] }[] };
const BODY = { font: "Microsoft YaHei", size: 21 };
const run = (text: string, extra?: { bold?: boolean; size?: number; break?: number }) => new TextRun({ text, ...BODY, ...extra });
/** Only immutable, owned graphs from ResumeArtifactService may reach the generator. */
export async function buildResumeDocx(source: Source): Promise<Uint8Array> {
  const header = parseResumeHeaderSnapshot(source.headerSnapshot);
  const children: Paragraph[] = [];
  // Sizes follow the print preview: name is text-2xl (18pt), body copy is text-sm (10.5pt).
  if (header.fullName) children.push(new Paragraph({ children: [run(header.fullName, { bold: true, size: 36 })], spacing: { after: 80 } }));
  if (header.headline) children.push(new Paragraph({ children: [run(header.headline)], spacing: { after: 40 } }));
  const contact = [header.email, header.phone, header.address].filter(Boolean).join(" · ");
  const links = header.links.map((link) => link.url).filter(Boolean).join(" · ");
  if (contact) children.push(new Paragraph({ children: [run(contact)] }));
  if (links) children.push(new Paragraph({ children: [run(links)], spacing: { before: 40 } }));
  for (const section of source.sections) {
    if (section.hiddenAt) continue;
    children.push(new Paragraph({
      children: [run(section.title.toLocaleUpperCase(), { bold: true })],
      keepNext: true,
      spacing: { before: 200, after: 80 },
    }));
    for (const item of section.items) {
      if (item.hiddenAt) continue;
      if (item.materialTitleSnapshot) children.push(new Paragraph({ children: [run(item.materialTitleSnapshot, { bold: true })], keepNext: true }));
      for (const expression of item.expressions) {
        if (expression.hiddenAt || !expression.content.trim()) continue;
        const lines = expression.content.split(/\r?\n/);
        const runs = lines.flatMap((text, i) => [run(text, i > 0 ? { break: 1 } : undefined)]);
        children.push(new Paragraph({ children: runs, ...(expression.kind === "BODY" ? {} : { bullet: { level: 0 } }), spacing: { after: 80 } }));
      }
    }
  }
  return new Uint8Array(await Packer.toBuffer(new Document({
    styles: { default: { document: { run: BODY, paragraph: { spacing: { line: 276 } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 850, bottom: 850, left: 850, right: 850 } } }, children }],
  })));
}

import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { parseResumeHeaderSnapshot } from "./resumeHeaderSnapshot";
type Source = { headerSnapshot: string | null; sections: { title: string; hiddenAt?: Date | string | null; items: { materialTitleSnapshot?: string | null; hiddenAt?: Date | string | null; expressions: { kind: string; content: string; hiddenAt?: Date | string | null }[] }[] }[] };
/** Only immutable, owned graphs from ResumeArtifactService may reach the generator. */
export async function buildResumeDocx(source: Source): Promise<Uint8Array> {
  const header = parseResumeHeaderSnapshot(source.headerSnapshot);
  const children: Paragraph[] = [];
  if (header.fullName) children.push(new Paragraph({ text: header.fullName, heading: HeadingLevel.TITLE }));
  if (header.headline) children.push(new Paragraph(header.headline));
  const contact = [header.email, header.phone, header.address, ...header.links.map((x) => x.url)].filter(Boolean).join(" · ");
  if (contact) children.push(new Paragraph(contact));
  for (const section of source.sections) {
    if (section.hiddenAt) continue;
    children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_2, keepNext: true }));
    for (const item of section.items) {
      if (item.hiddenAt) continue;
      if (item.materialTitleSnapshot) children.push(new Paragraph({ children: [new TextRun({ text: item.materialTitleSnapshot, bold: true })], keepNext: true }));
      for (const expression of item.expressions) {
        if (expression.hiddenAt || !expression.content.trim()) continue;
        const lines = expression.content.split(/\r?\n/);
        const runs = lines.flatMap((text, i) => [new TextRun({ text, ...(i > 0 ? { break: 1 } : {}) })]);
        children.push(new Paragraph({ children: runs, ...(expression.kind === "BULLET" ? { bullet: { level: 0 } } : {}), spacing: { after: 80 } }));
      }
    }
  }
  return new Uint8Array(await Packer.toBuffer(new Document({
    styles: { default: { document: { run: { font: "Microsoft YaHei", size: 21 }, paragraph: { spacing: { line: 276 } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 850, bottom: 850, left: 850, right: 850 } } }, children }],
  })));
}

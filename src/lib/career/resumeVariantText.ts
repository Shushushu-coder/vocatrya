import { parseResumeHeaderSnapshot } from "./resumeHeaderSnapshot";

export type ResumeVariantTextItem = {
  careerMaterialItem?: { title: string | null } | null;
  expressions: Array<{ content: string }>;
};

export type ResumeVariantTextSection = {
  title: string;
  items: ResumeVariantTextItem[];
};

export type ResumeVariantTextSource = {
  headerSnapshot: string | null;
  sections: ResumeVariantTextSection[];
};

/**
 * Read-only text for the resume the workspace preview already shows.
 * Header fields and expression content only — evidence snapshots stay out.
 */
export function projectResumeVariantText(source: ResumeVariantTextSource): string {
  const header = parseResumeHeaderSnapshot(source.headerSnapshot);
  const headerLines = [
    header.fullName,
    header.headline,
    header.email,
    header.phone,
    header.address,
    ...header.links.map((link) => link.url),
  ].filter((line): line is string => Boolean(line && line.trim()));

  const parts: string[] = [];
  if (headerLines.length > 0) {
    parts.push(headerLines.join("\n"));
  }

  for (const section of source.sections) {
    const lines: string[] = [];
    const title = section.title.trim();
    if (title) lines.push(`## ${title}`);
    for (const item of section.items) {
      const itemTitle = item.careerMaterialItem?.title?.trim();
      if (itemTitle) lines.push(itemTitle);
      for (const expression of item.expressions) {
        const content = expression.content.trim();
        if (content) lines.push(content);
      }
    }
    if (lines.length > 0) parts.push(lines.join("\n"));
  }

  return parts.join("\n\n");
}

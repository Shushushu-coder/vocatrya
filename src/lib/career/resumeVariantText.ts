import { parseResumeHeaderSnapshot } from "./resumeHeaderSnapshot";

export type ResumeVariantTextItem = {
  hiddenAt?: Date | string | null;
  materialTitleSnapshot?: string | null;
  careerMaterialItem?: { title: string | null } | null;
  expressions: Array<{ content: string; hiddenAt?: Date | string | null }>;
};

export type ResumeVariantTextSection = {
  hiddenAt?: Date | string | null;
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
    if (section.hiddenAt) continue;
    const lines: string[] = [];
    const title = section.title.trim();
    if (title) lines.push(`## ${title}`);
    for (const item of section.items) {
      if (item.hiddenAt) continue;
      const itemTitle = item.materialTitleSnapshot?.trim();
      if (itemTitle) lines.push(itemTitle);
      for (const expression of item.expressions) {
        if (expression.hiddenAt) continue;
        const content = expression.content.trim();
        if (content) lines.push(content);
      }
    }
    if (lines.length > 0) parts.push(lines.join("\n"));
  }

  return parts.join("\n\n");
}

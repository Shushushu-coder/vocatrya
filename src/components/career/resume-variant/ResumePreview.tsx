"use client";
import "./ResumePreview.css";
import { parseResumeHeaderSnapshot } from "@/lib/career/resumeHeaderSnapshot";
import { useI18n } from "@/i18n";

type Expression = {
  kind?: string;
  hiddenAt?: Date | string | null;
  id: string;
  content: string;
  sortOrder: number;
};

type Item = {
  hiddenAt?: Date | string | null;
  id: string;
  expressions: Expression[];
  materialTitleSnapshot?: string | null;
  careerMaterialItem?: { title: string | null } | null;
};

type Section = {
  hiddenAt?: Date | string | null;
  id: string;
  title: string;
  items: Item[];
};

type ResumePreviewProps = {
  headerSnapshot: string | null;
  sections: Section[];
  print?: boolean;
};

export function ResumePreview({ headerSnapshot, sections, print = false }: ResumePreviewProps) {
  const { t } = useI18n();
  const header = parseResumeHeaderSnapshot(headerSnapshot);
  const contact = [header.email, header.phone, header.address].filter(Boolean);
  const links = header.links.map((link) => link.url);

  return (
    <article
      className={print ? "resume-print bg-white text-black" : "rounded-lg border bg-background p-6 shadow-xs"}
      data-testid={print ? "resume-print-preview" : "resume-browser-preview"}
    >
      {!print && <p className="mb-4 text-xs text-muted-foreground">
        {t("resumeVariants.previewReadOnly")}
      </p>}
      <header className="border-b pb-4">
        {(!print || header.fullName) && <h2 className="text-2xl font-semibold">{header.fullName || t("applicationProfile.emptyValue")}</h2>}
        {header.headline ? (
          <p className="mt-1 text-sm text-muted-foreground">{header.headline}</p>
        ) : null}
        {contact.length > 0 ? (
          <p className="mt-2 text-sm">{contact.join(" · ")}</p>
        ) : null}
        {links.length > 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">{links.join(" · ")}</p>
        ) : null}
      </header>
      <div className="mt-6 space-y-5">
        {sections.filter((section) => !section.hiddenAt).map((section) => (
          <section key={section.id} data-resume-block={section.id}>
            <h3 data-resume-block={`${section.id}-title`} className="border-b pb-1 text-sm font-semibold uppercase tracking-wide">
              {section.title}
            </h3>
            <div className="mt-3 space-y-3">
              {section.items.filter((item) => !item.hiddenAt).map((item) => (
                <div key={item.id} data-resume-block={item.id} className="resume-print-item">
                  {item.materialTitleSnapshot ? (
                    <p className="text-sm font-medium">{item.materialTitleSnapshot}</p>
                  ) : null}
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                    {item.expressions.filter((expression) => !expression.hiddenAt && (!print || expression.content.trim())).map((expression) => (
                      <li data-resume-block={expression.id} key={expression.id} className={`whitespace-pre-wrap ${expression.kind === "BODY" ? "list-none -ml-5" : ""}`}>
                        {expression.content}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}

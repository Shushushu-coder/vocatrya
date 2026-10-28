/** Project plain JD source into the HTML consumed by the job viewer/editor. */
export function plainJobDescriptionHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<p>${escaped.replace(/\r\n|\r|\n/g, "<br>")}</p>`;
}

export function jobDescriptionEditorHtml(job: { description: string; descriptionFormat?: string }): string {
  return job.descriptionFormat === "PLAIN_TEXT"
    ? plainJobDescriptionHtml(job.description)
    : job.description;
}

import { renderToString } from "react-dom/server";
import Tiptap from "@/components/TiptapEditor";

// @tiptap/react warns (and historically risked a hydration mismatch) when
// useEditor runs during SSR without an explicit immediatelyRender option.
// jsdom is not a real SSR environment, so emulate what tiptap checks: it
// treats `window.next` as a Next.js SSR signal.
describe("TiptapEditor SSR", () => {
  const field = {
    value: "<p>existing content</p>",
    onChange: () => {},
    onBlur: () => {},
    name: "jobDescription",
    ref: () => {},
  } as any;

  it("does not emit the Tiptap SSR warning during server render", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    (window as any).next = {};
    try {
      renderToString(<Tiptap field={field} />);
      for (const spy of [warnSpy, errorSpy]) {
        for (const call of spy.mock.calls) {
          expect(String(call[0])).not.toContain("immediatelyRender");
          expect(String(call[0])).not.toContain("Tiptap Error");
        }
      }
    } finally {
      delete (window as any).next;
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("still renders the editor container in the DOM", () => {
    const html = renderToString(<Tiptap field={field} />);
    // immediatelyRender:false renders the labelled container; the editable
    // content is painted on the client after hydration.
    expect(html).toContain('aria-labelledby="job-description-label"');
  });
});

import {
  TagFilterStrip,
  buildStripItems,
  pinSelectedFirst,
} from "@/components/TagFilterStrip";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const user = userEvent.setup({ skipHover: true });

const ITEMS = [
  { id: "alpha", label: "Alpha", count: 5 },
  { id: "beta", label: "Beta", count: 3 },
  { id: "gamma", label: "Gamma", count: 0 },
];

function renderStrip(overrides: Partial<Parameters<typeof TagFilterStrip>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <TagFilterStrip
      title="Skill Tags"
      items={ITEMS}
      totalCount={9}
      onSelect={onSelect}
      {...overrides}
    />,
  );
  return { onSelect };
}

describe("TagFilterStrip", () => {
  describe("rendering", () => {
    it("shows the section title, an All chip and every non-empty item", () => {
      renderStrip();

      expect(screen.getByText("Skill Tags")).toBeInTheDocument();
      const allChip = screen.getByRole("button", { name: /All/i });
      expect(within(allChip).getByText("9")).toBeInTheDocument();
      expect(screen.getByText("Alpha")).toBeInTheDocument();
      expect(screen.getByText("Beta")).toBeInTheDocument();
      // Zero-count categories are hidden unless selected.
      expect(screen.queryByText("Gamma")).not.toBeInTheDocument();
    });

    it("orders items by count descending", () => {
      renderStrip({
        items: [
          { id: "low", label: "Low", count: 1 },
          { id: "high", label: "High", count: 9 },
        ],
      });

      const labels = screen
        .getAllByRole("button")
        .map((button) => button.textContent);
      expect(labels.indexOf("High9")).toBeLessThan(labels.indexOf("Low1"));
    });

    it("keeps a zero-count selected item visible", () => {
      renderStrip({ selectedId: "gamma" });

      const gammaChip = screen.getByRole("button", { name: /Gamma/i });
      expect(gammaChip).toHaveAttribute("aria-pressed", "true");
    });

    it("truncates long names and exposes the full label via title", () => {
      const longLabel = "A".repeat(60);
      renderStrip({ items: [{ id: "long", label: longLabel, count: 2 }] });

      const chip = screen
        .getAllByRole("button")
        .find((button) => button.getAttribute("title") === longLabel);
      expect(chip).toBeDefined();
      expect(chip!.querySelector(".truncate")).toBeInTheDocument();
    });
  });

  describe("single selection", () => {
    it("selects an item on click and stays selected on repeat click", async () => {
      const { onSelect } = renderStrip();
      const alphaChip = screen.getByRole("button", { name: /Alpha/i });

      await user.click(alphaChip);
      expect(onSelect).toHaveBeenCalledWith("alpha");
    });

    it("does not call onSelect when the selected item is clicked again", async () => {
      const { onSelect } = renderStrip({ selectedId: "alpha" });
      const alphaChip = screen.getByRole("button", { name: /Alpha/i });

      await user.click(alphaChip);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("clears the restriction via the All chip", async () => {
      const { onSelect } = renderStrip({ selectedId: "alpha" });
      await user.click(screen.getByRole("button", { name: /All/i }));
      expect(onSelect).toHaveBeenCalledWith(undefined);
    });

    it("does not call onSelect when All is clicked while already active", async () => {
      const { onSelect } = renderStrip();
      await user.click(screen.getByRole("button", { name: /All/i }));
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("marks the selected chip with aria-pressed", () => {
      renderStrip({ selectedId: "beta" });

      expect(screen.getByRole("button", { name: /Beta/i })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: /All/i })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  describe("collapse and expand", () => {
    // jsdom performs no layout, so scrollHeight/offsetHeight are stubbed onto
    // the strip's content box and the captured ResizeObserver callback is
    // invoked manually to simulate "content exceeds two rows".
    function stubOverflowingLayout(container: HTMLElement) {
      const content = container.querySelector(
        ".flex.flex-wrap",
      ) as HTMLElement;
      Object.defineProperty(content, "scrollHeight", {
        value: 200,
        configurable: true,
      });
      const chip = content.querySelector("[data-chip]") as HTMLElement;
      Object.defineProperty(chip, "offsetHeight", {
        value: 24,
        configurable: true,
      });
    }

    function captureResizeObserver() {
      let callback: ResizeObserverCallback | undefined;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: ResizeObserverCallback) {
            callback = cb;
          }
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      return () => callback;
    }

    const manyItems = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      label: `Tag ${i}`,
      count: i + 1,
    }));

    it("hides the toggle when content fits two rows", () => {
      const getCallback = captureResizeObserver();
      renderStrip();

      expect(getCallback()).toBeDefined();
      expect(
        screen.queryByRole("button", { name: /expand all/i }),
      ).not.toBeInTheDocument();
    });

    it("shows Expand all on overflow and toggles to Collapse", async () => {
      const getCallback = captureResizeObserver();
      const onSelect = vi.fn();
      const { container } = render(
        <TagFilterStrip
          title="Skill Tags"
          items={manyItems}
          totalCount={210}
          onSelect={onSelect}
        />,
      );

      stubOverflowingLayout(container);
      const measure = getCallback();
      expect(measure).toBeDefined();
      act(() => measure!([], {} as ResizeObserver));

      const expandButton = await screen.findByRole("button", {
        name: /expand all/i,
      });
      await user.click(expandButton);

      expect(
        screen.getByRole("button", { name: /collapse/i }),
      ).toBeInTheDocument();
    });

    it("pins the selected chip right after All while collapsed", async () => {
      const getCallback = captureResizeObserver();
      const onSelect = vi.fn();
      const { container } = render(
        <TagFilterStrip
          title="Skill Tags"
          items={manyItems}
          totalCount={210}
          selectedId="t0"
          onSelect={onSelect}
        />,
      );

      stubOverflowingLayout(container);
      const measure = getCallback();
      act(() => measure!([], {} as ResizeObserver));

      const chips = container.querySelectorAll("[data-chip]");
      // t0 has the lowest count so it sorts last; collapsed overflow must
      // still surface it, pinned directly behind the All chip.
      expect(chips[1].textContent).toContain("Tag 0");
    });

    it("reveals a clipped chip reached by keyboard focus", () => {
      const getCallback = captureResizeObserver();
      const { container } = render(<TagFilterStrip title="Tags" items={manyItems} totalCount={210} onSelect={vi.fn()} />);
      stubOverflowingLayout(container);
      act(() => getCallback()!([], {} as ResizeObserver));
      const clippedChip = container.querySelectorAll<HTMLElement>("[data-chip]")[10];
      Object.defineProperty(clippedChip, "offsetTop", { configurable: true, value: 80 });
      act(() => clippedChip.focus());
      expect(screen.getByRole("button", { name: /collapse/i })).toHaveAttribute("aria-expanded", "true");
    });

    it("restores count order when expanded", async () => {
      const getCallback = captureResizeObserver();
      const onSelect = vi.fn();
      const { container } = render(
        <TagFilterStrip
          title="Skill Tags"
          items={manyItems}
          totalCount={210}
          selectedId="t0"
          onSelect={onSelect}
        />,
      );

      stubOverflowingLayout(container);
      const measure = getCallback();
      act(() => measure!([], {} as ResizeObserver));

      await user.click(
        await screen.findByRole("button", { name: /expand all/i }),
      );

      const chips = container.querySelectorAll("[data-chip]");
      expect(chips[1].textContent).toContain("Tag 19");
      expect(chips[chips.length - 1].textContent).toContain("Tag 0");
    });
  });

  describe("buildStripItems", () => {
    it("drops zero-count items but keeps the selected one", () => {
      const result = buildStripItems(ITEMS, "gamma");
      expect(result.map((item) => item.id)).toEqual([
        "alpha",
        "beta",
        "gamma",
      ]);
    });

    it("sorts by count descending", () => {
      const result = buildStripItems([
        { id: "a", label: "A", count: 2 },
        { id: "b", label: "B", count: 7 },
      ]);
      expect(result.map((item) => item.id)).toEqual(["b", "a"]);
    });
  });

  describe("pinSelectedFirst", () => {
    it("moves the selected item to the front", () => {
      const pinned = pinSelectedFirst(ITEMS, "beta");
      expect(pinned.map((item) => item.id)).toEqual([
        "beta",
        "alpha",
        "gamma",
      ]);
    });

    it("returns the input order when nothing is selected", () => {
      expect(pinSelectedFirst(ITEMS).map((item) => item.id)).toEqual(
        ITEMS.map((item) => item.id),
      );
    });

    it("returns the input order when the selected item is already first", () => {
      expect(
        pinSelectedFirst(ITEMS, "alpha").map((item) => item.id),
      ).toEqual(ITEMS.map((item) => item.id));
    });
  });
});

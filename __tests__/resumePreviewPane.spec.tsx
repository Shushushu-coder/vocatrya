// RESUME-BUILDER B7: the pane must apply the stored device snapshot before
// any persistence — the initial default render never reaches the store,
// including under StrictMode's mount-effect replay.
import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { ResumePreviewPane } from "@/components/career/resume-variant/ResumePreviewPane";
import { RESUME_PREVIEW_STORAGE_KEY } from "@/lib/resumePreviewPreferences";

const STORED = { hidden: true, width: 1026 };
const STORED_RAW = JSON.stringify(STORED);
const DEFAULT_RAW = JSON.stringify({ hidden: false, width: 480 });

function deviceBridge(initial: string | null) {
  const calls: string[] = [];
  let device = initial;
  window.vocatryaResume = {
    printToPDF: vi.fn(),
    readPreviewPreferences: () => device,
    writePreviewPreferences: (raw: string) => {
      calls.push(raw);
      device = raw;
      return raw;
    },
  };
  return {
    calls,
    get device() {
      return device;
    },
  };
}

function renderPane(strict = false) {
  const pane = (
    <ResumePreviewPane>
      <div data-testid="preview-body" />
    </ResumePreviewPane>
  );
  return render(strict ? <StrictMode>{pane}</StrictMode> : pane);
}

describe("ResumePreviewPane preference persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    delete window.vocatryaResume;
  });

  it("restores the stored snapshot without writing the defaults first", async () => {
    const bridge = deviceBridge(STORED_RAW);
    renderPane();
    expect(await screen.findByRole("button", { name: "Show preview" })).toBeVisible();
    expect(screen.queryByTestId("preview-body")).not.toBeInTheDocument();
    expect(bridge.calls).toEqual([STORED_RAW]);
    expect(bridge.calls).not.toContain(DEFAULT_RAW);
    expect(bridge.device).toBe(STORED_RAW);
    // The restored write-back refills the localStorage mirror for readers
    // (and acceptance probes) on the fresh launch origin.
    expect(localStorage.getItem(RESUME_PREVIEW_STORAGE_KEY)).toBe(STORED_RAW);
  });

  it("keeps the restored snapshot under StrictMode mount-effect replay", async () => {
    const bridge = deviceBridge(STORED_RAW);
    renderPane(true);
    expect(await screen.findByRole("button", { name: "Show preview" })).toBeVisible();
    expect(bridge.calls).toEqual([STORED_RAW]);
    expect(bridge.calls).not.toContain(DEFAULT_RAW);
  });

  it("still persists user changes after the restore", async () => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1500,
    });
    const bridge = deviceBridge(STORED_RAW);
    const user = userEvent.setup();
    renderPane();
    await user.click(await screen.findByRole("button", { name: "Show preview" }));
    expect(bridge.calls).toEqual([
      STORED_RAW,
      JSON.stringify({ hidden: false, width: 1026 }),
    ]);
    screen
      .getByRole("separator", { name: "Drag to resize the preview" })
      .focus();
    await user.keyboard("{ArrowLeft}");
    expect(bridge.calls).toEqual([
      STORED_RAW,
      JSON.stringify({ hidden: false, width: 1026 }),
      JSON.stringify({ hidden: false, width: 1050 }),
    ]);
  });
});

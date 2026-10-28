// F4-UI-001: OpenRouter is a selectable interview provider but has no
// curated model enum, so the dropdown-only picker deadlocked the form
// (0 options, save disabled). The fix gives OpenRouter a free-text model
// input; all other providers keep the curated Select.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, vi } from "vitest";
import InterviewAiSettings from "@/components/settings/InterviewAiSettings";

// The established shim for driving Radix Select in jsdom — see TaskForm.spec.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
});

vi.mock("@/i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${Object.values(params).join("/")}` : key,
  }),
}));

const getUserSettings = vi.fn();
const updateInterviewAiSettings = vi.fn();
vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: (...args: unknown[]) => getUserSettings(...args),
  updateInterviewAiSettings: (...args: unknown[]) =>
    updateInterviewAiSettings(...args),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@/lib/toast", () => ({
  toastSuccess: (...args: unknown[]) => toastSuccess(...args),
  toastError: (...args: unknown[]) => toastError(...args),
}));

const emptySettings = {
  success: true,
  data: {
    userId: "u-1",
    settings: {
      ai: { provider: "ollama", model: undefined },
      display: { theme: "system" },
    },
  },
};

async function renderLoaded(settings: unknown = emptySettings) {
  getUserSettings.mockResolvedValue(settings);
  render(<InterviewAiSettings />);
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "interview.provider" }),
    ).toBeInTheDocument(),
  );
}

async function pickProvider(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("combobox", { name: "interview.provider" }));
  await user.click(await screen.findByRole("option", { name }));
}

const saveButton = () =>
  screen.getByRole("button", { name: "interview.saveInterviewAi" });

describe("InterviewAiSettings — OpenRouter model selection (F4-UI-001)", () => {
  beforeEach(() => {
    getUserSettings.mockReset();
    updateInterviewAiSettings.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("offers a usable free-text model control and saves provider/model", async () => {
    updateInterviewAiSettings.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    await renderLoaded();

    await pickProvider(user, "OpenRouter");

    // The model control is a labelled text input, not the empty dropdown.
    const modelInput = screen.getByLabelText("interview.model");
    expect(modelInput.tagName).toBe("INPUT");
    expect(screen.queryByRole("combobox", { name: "interview.model" })).toBeNull();
    expect(saveButton()).toBeDisabled();

    await user.type(modelInput, "openai/gpt-4o-mini");
    expect(saveButton()).toBeEnabled();

    await user.click(saveButton());
    await waitFor(() =>
      expect(updateInterviewAiSettings).toHaveBeenCalledWith({
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
      }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it("keeps save disabled while the OpenRouter model is empty or blank", async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await pickProvider(user, "OpenRouter");

    const modelInput = screen.getByLabelText("interview.model");
    expect(saveButton()).toBeDisabled();

    await user.type(modelInput, "   ");
    expect(saveButton()).toBeDisabled();
    expect(updateInterviewAiSettings).not.toHaveBeenCalled();
  });

  it("clears the previous model when switching providers", async () => {
    updateInterviewAiSettings.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    await renderLoaded();

    await pickProvider(user, "DeepSeek");
    await user.click(screen.getByRole("combobox", { name: "interview.model" }));
    await user.click(await screen.findByRole("option", { name: "deepseek-chat" }));
    expect(saveButton()).toBeEnabled();

    await pickProvider(user, "OpenRouter");

    const modelInput = screen.getByLabelText("interview.model");
    expect(modelInput).toHaveValue("");
    expect(saveButton()).toBeDisabled();
    // The previous provider's model must not be silently submitted.
    await user.type(modelInput, "deepseek/deepseek-chat");
    await user.click(saveButton());
    await waitFor(() =>
      expect(updateInterviewAiSettings).toHaveBeenCalledWith({
        provider: "openrouter",
        model: "deepseek/deepseek-chat",
      }),
    );
  });

  it("restores a persisted openrouter provider/model pair on reload", async () => {
    updateInterviewAiSettings.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    await renderLoaded({
      success: true,
      data: {
        userId: "u-1",
        settings: {
          ai: {
            provider: "ollama",
            model: undefined,
            interview: {
              provider: "openrouter",
              model: "anthropic/claude-sonnet-4.5",
            },
          },
          display: { theme: "system" },
        },
      },
    });

    // Full `provider/model` id is preserved verbatim — no truncation.
    const modelInput = await screen.findByLabelText("interview.model");
    expect(modelInput).toHaveValue("anthropic/claude-sonnet-4.5");
    expect(saveButton()).toBeEnabled();

    await user.click(saveButton());
    await waitFor(() =>
      expect(updateInterviewAiSettings).toHaveBeenCalledWith({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
      }),
    );
  });

  it("saves an Enter-submitted model id", async () => {
    updateInterviewAiSettings.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    await renderLoaded();
    await pickProvider(user, "OpenRouter");

    await user.type(
      screen.getByLabelText("interview.model"),
      "google/gemini-2.5-flash{Enter}",
    );
    await waitFor(() =>
      expect(updateInterviewAiSettings).toHaveBeenCalledWith({
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
      }),
    );
  });

  it.each([
    ["DeepSeek", "deepseek-chat"],
  ])(
    "keeps the curated dropdown for %s — regression",
    async (providerName, expectedOption) => {
      const user = userEvent.setup();
      await renderLoaded();

      await pickProvider(user, providerName);

      // Model control stays a Select, not a text input.
      const modelSelect = screen.getByRole("combobox", {
        name: "interview.model",
      });
      expect(modelSelect).toBeEnabled();
      expect(screen.queryByRole("textbox", { name: "interview.model" })).toBeNull();

      await user.click(modelSelect);
      await user.click(
        await screen.findByRole("option", { name: expectedOption }),
      );
      expect(saveButton()).toBeEnabled();
    },
  );

  it("disables the model dropdown when no provider is selected", async () => {
    await renderLoaded();
    expect(
      screen.getByRole("combobox", { name: "interview.model" }),
    ).toBeDisabled();
    expect(saveButton()).toBeDisabled();
  });
});

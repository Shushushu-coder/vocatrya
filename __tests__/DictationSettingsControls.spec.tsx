// AWU-DICTATION settings block: provider/model/credential editing stays
// inside the dictation namespace, key save/delete goes through the
// dictation actions, and only metadata ever renders. N-2: dictation is
// Gemini-only — the provider picker offers a single option and the key
// guidance links to Google AI Studio.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DictationSettingsControls } from "@/components/settings/DictationSettingsControls";

const actions = vi.hoisted(() => ({
  getDictationSettings: vi.fn(),
  updateDictationSettings: vi.fn(),
  saveDictationKey: vi.fn(),
  deleteDictationKey: vi.fn(),
}));
vi.mock("@/actions/dictation.actions", () => actions);
vi.mock("@/lib/toast", () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const EMPTY_CREDENTIALS = {
  gemini: { shared: null, dedicated: null },
};

function settings(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      config: null,
      credentials: EMPTY_CREDENTIALS,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.getDictationSettings.mockResolvedValue(settings());
  actions.updateDictationSettings.mockResolvedValue({ success: true });
  actions.saveDictationKey.mockResolvedValue({
    success: true,
    data: { last4: "1234", protection: "os" },
  });
  actions.deleteDictationKey.mockResolvedValue({ success: true });
});

describe("DictationSettingsControls", () => {
  it("keeps unsaved model and credential edits when saving a dedicated key", async () => {
    actions.getDictationSettings.mockResolvedValue(settings({ config: {
      provider: "gemini", model: "gemini-3.5-flash-lite", credentialMode: "shared",
    } }));
    const user = userEvent.setup();
    render(<DictationSettingsControls />);
    await screen.findByTestId("dictation-model");
    await user.clear(screen.getByTestId("dictation-model"));
    await user.type(screen.getByTestId("dictation-model"), "gemini-3.5-transcribe");
    await user.selectOptions(screen.getByTestId("dictation-credential-mode"), "dedicated");
    await user.type(screen.getByTestId("dictation-key-input"), "AIza-key");
    await user.click(screen.getByTestId("dictation-key-save"));
    await waitFor(() => expect(screen.getByTestId("dictation-key-badge")).toHaveTextContent("1234"));
    expect(screen.getByTestId("dictation-model")).toHaveValue("gemini-3.5-transcribe");
    expect(screen.getByTestId("dictation-credential-mode")).toHaveValue("dedicated");
    expect(actions.getDictationSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Test transcription" })).toBeDisabled();
    await user.click(screen.getByTestId("dictation-save"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Test transcription" })).toBeEnabled());
  });

  it("renders Gemini as the only provider option after loading", async () => {
    render(<DictationSettingsControls />);
    const select = await screen.findByTestId("dictation-provider");
    expect(
      (await within(select).findAllByRole("option")).map(o => (o as HTMLOptionElement).value),
    ).toEqual(["gemini"]);
    expect(screen.getByTestId("dictation-model")).toBeInTheDocument();
    expect(
      screen.getByTestId("dictation-credential-mode"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("dictation-key-badge")).toHaveTextContent(
      "Not configured",
    );
  });

  it("links the API key guidance to Google AI Studio", async () => {
    render(<DictationSettingsControls />);
    const link = await screen.findByTestId("dictation-get-key-link");
    expect(link).toHaveAttribute("href", "https://aistudio.google.com/api-keys");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("restores the persisted config and shows the key badge", async () => {
    actions.getDictationSettings.mockResolvedValue(
      settings({
        config: {
          provider: "gemini",
          model: "gemini-2.5-flash",
          credentialMode: "dedicated",
        },
        credentials: {
          ...EMPTY_CREDENTIALS,
          gemini: {
            shared: null,
            dedicated: { last4: "zz99", protection: "os" },
          },
        },
      }),
    );
    render(<DictationSettingsControls />);
    await waitFor(() =>
      expect(
        (screen.getByTestId("dictation-provider") as HTMLSelectElement)
          .value,
      ).toBe("gemini"),
    );
    expect(
      (screen.getByTestId("dictation-model") as HTMLInputElement).value,
    ).toBe("gemini-2.5-flash");
    expect(screen.getByTestId("dictation-key-badge")).toHaveTextContent(
      "zz99",
    );
    expect(screen.getByTestId("dictation-key-badge")).not.toHaveTextContent(
      /ENC|encryptedKey/i,
    );
  });

  it("saves the independent dictation config", async () => {
    const user = userEvent.setup();
    render(<DictationSettingsControls />);
    await waitFor(() =>
      expect(screen.getByTestId("dictation-model")).toBeInTheDocument(),
    );
    const model = screen.getByTestId("dictation-model");
    await user.clear(model);
    await user.type(model, "gemini-3.5-transcribe");
    await user.click(screen.getByTestId("dictation-save"));
    expect(actions.updateDictationSettings).toHaveBeenCalledWith({
      provider: "gemini",
      model: "gemini-3.5-transcribe",
      credentialMode: "shared",
    });
  });

  it("saves a dedicated key through the dictation key action", async () => {
    const user = userEvent.setup();
    render(<DictationSettingsControls />);
    await waitFor(() =>
      expect(screen.getByTestId("dictation-key-input")).toBeInTheDocument(),
    );
    await user.selectOptions(
      screen.getByTestId("dictation-credential-mode"),
      "dedicated",
    );
    await user.type(
      screen.getByTestId("dictation-key-input"),
      "AIza-dictation",
    );
    await user.click(screen.getByTestId("dictation-key-save"));
    expect(actions.saveDictationKey).toHaveBeenCalledWith({
      provider: "gemini",
      credentialMode: "dedicated",
      key: "AIza-dictation",
    });
    expect(actions.saveDictationKey.mock.calls[0]![0]).not.toHaveProperty(
      "credentialMode",
      "shared",
    );
  });

  it("offers delete only for a stored dedicated key", async () => {
    actions.getDictationSettings.mockResolvedValue(
      settings({
        config: {
          provider: "gemini",
          model: "gemini-3.5-flash-lite",
          credentialMode: "dedicated",
        },
        credentials: {
          ...EMPTY_CREDENTIALS,
          gemini: {
            shared: null,
            dedicated: { last4: "9999", protection: "os" },
          },
        },
      }),
    );
    const user = userEvent.setup();
    render(<DictationSettingsControls />);
    await waitFor(() =>
      expect(
        screen.getByTestId("dictation-key-delete"),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByTestId("dictation-key-delete"));
    expect(actions.deleteDictationKey).toHaveBeenCalledWith({
      provider: "gemini",
      credentialMode: "dedicated",
    });
  });
});

import DictionaryLabelDialog from "@/components/admin/DictionaryLabelDialog";
import { screen, render, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toastError } from "@/lib/toast";

vi.mock("@/lib/toast", () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));

describe("DictionaryLabelDialog", () => {
  const user = userEvent.setup();

  const renderDialog = (overrides: Partial<Parameters<typeof DictionaryLabelDialog>[0]> = {}) => {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      title: "Edit job title",
      fieldLabel: "Name",
      initialLabel: "Developer",
      submit: vi.fn(),
      onSaved: vi.fn(),
      ...overrides,
    };
    render(<DictionaryLabelDialog {...props} />);
    return props;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("seeds the input with the label being edited", async () => {
    renderDialog();

    expect(await screen.findByDisplayValue("Developer")).toBeInTheDocument();
  });

  it("submits the trimmed label, closes and reloads on success", async () => {
    const props = renderDialog({
      submit: vi.fn().mockResolvedValue({ success: true }),
    });

    const input = await screen.findByDisplayValue("Developer");
    await user.clear(input);
    await user.type(input, "  Senior Dev  ");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(props.submit).toHaveBeenCalledWith("Senior Dev");
    });
    await waitFor(() => {
      expect(props.onOpenChange).toHaveBeenCalledWith(false);
      expect(props.onSaved).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the dialog open and preserves the draft when save fails", async () => {
    const props = renderDialog({
      submit: vi
        .fn()
        .mockResolvedValue({ success: false, message: "Job title already exists!" }),
    });

    const input = await screen.findByDisplayValue("Developer");
    await user.clear(input);
    await user.type(input, "Designer");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(props.submit).toHaveBeenCalledWith("Designer");
    });
    // No close signal, no reload — the user can retry with their text intact.
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Designer")).toBeInTheDocument();
  });

  it("blocks submit for an empty label without calling the action", async () => {
    const props = renderDialog();

    const input = await screen.findByDisplayValue("Developer");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByText("Label cannot be empty.")).toBeInTheDocument();
    });
    expect(props.submit).not.toHaveBeenCalled();
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it("reports a rejected request and preserves the draft for retry", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("Network failure"))
      .mockResolvedValueOnce({ success: true });
    const props = renderDialog({ submit });
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Designer");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.getByLabelText("Name")).toHaveValue("Designer");
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(props.onSaved).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenNthCalledWith(2, "Designer");
  });

  it("protects the pending draft from edits, repeated saves and dismissal", async () => {
    let finish!: (result: { success: boolean; message: string }) => void;
    const pending = new Promise<{ success: boolean; message: string }>((resolve) => {
      finish = resolve;
    });
    const props = renderDialog({ submit: vi.fn(() => pending) });
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Designer");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeDisabled());
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.keyboard("{Escape}");
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(props.submit).toHaveBeenCalledTimes(1);
    await act(async () => finish({ success: false, message: "Please retry" }));
    await waitFor(() => expect(screen.getByLabelText("Name")).toBeEnabled());
    expect(screen.getByLabelText("Name")).toHaveValue("Designer");
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it("re-seeds the draft when a different row is opened", async () => {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      title: "Edit skill",
      fieldLabel: "Name",
      initialLabel: "React",
      submit: vi.fn(),
      onSaved: vi.fn(),
    };
    const { rerender } = render(<DictionaryLabelDialog {...props} />);

    expect(await screen.findByDisplayValue("React")).toBeInTheDocument();

    rerender(<DictionaryLabelDialog {...props} initialLabel="Python" />);

    expect(await screen.findByDisplayValue("Python")).toBeInTheDocument();
  });

  it("starts empty for the add flow and calls onOpenChange on Cancel", async () => {
    const props = renderDialog({
      title: "Add location",
      initialLabel: undefined,
    });

    const input = await screen.findByLabelText("Name");
    expect(input).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.submit).not.toHaveBeenCalled();
  });
});

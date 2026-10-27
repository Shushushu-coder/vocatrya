import { Combobox } from "@/components/ComboBox";
import { I18nProvider } from "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { addCompany } from "@/actions/company.actions";
import { createLocation, createJobSource } from "@/actions/job.actions";
import { createJobTitle } from "@/actions/jobtitle.actions";
import { createActivityType } from "@/actions/activity.actions";
import { createContactRole } from "@/actions/contactRole.actions";
import { toastError } from "@/lib/toast";
import { getLocalizedJobSource } from "@/i18n/helpers";
import { translate } from "@/i18n/translate";
import { useForm } from "react-hook-form";
import { Form, FormField, FormItem } from "@/components/ui/form";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

vi.mock("@/actions/company.actions", () => ({
  addCompany: vi.fn(),
}));

vi.mock("@/actions/job.actions", () => ({
  createLocation: vi.fn(),
  createJobSource: vi.fn(),
}));

vi.mock("@/actions/jobtitle.actions", () => ({
  createJobTitle: vi.fn(),
}));

vi.mock("@/actions/activity.actions", () => ({
  createActivityType: vi.fn(),
}));

vi.mock("@/actions/contactRole.actions", () => ({
  createContactRole: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

// jsdom lacks scrollIntoView, which cmdk calls when selecting an item
Element.prototype.scrollIntoView = vi.fn();

const companies = [
  { id: "existing-id", value: "metallica inc", label: "Metallica Inc" },
  { id: "other-id", value: "acme corp", label: "Acme Corp" },
];

function Harness({
  onChange,
  creatable = true,
  name = "company",
  options = companies,
  freeText = false,
  label,
  onSearchChange,
  disabled = false,
}: {
  onChange: (v: string) => void;
  disabled?: boolean;
  creatable?: boolean;
  name?: string;
  options?: { id: string; value: string; label: string }[];
  freeText?: boolean;
  label?: string;
  onSearchChange?: (search: string) => void;
}) {
  const form = useForm({ defaultValues: { [name]: "" } });
  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name={name}
        render={({ field }) => (
          <FormItem>
            <Combobox
              options={[...options]}
              field={{
                ...field,
                disabled,
                onChange: (v: string) => {
                  onChange(v);
                  field.onChange(v);
                },
              }}
              creatable={creatable}
              freeText={freeText}
              label={label}
              onSearchChange={onSearchChange}
            />
          </FormItem>
        )}
      />
    </Form>
  );
}

type HarnessProps = Partial<React.ComponentProps<typeof Harness>>;

async function openCombobox(props: HarnessProps = {}) {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Harness onChange={onChange} {...props} />);

  await user.click(screen.getByRole("combobox"));
  const label = props.name ?? "company";
  const input = screen.getByPlaceholderText(
    new RegExp(`Search ${label}`, "i")
  ) as HTMLInputElement;
  return { user, onChange, input };
}

beforeEach(() => {
  vi.mocked(addCompany).mockResolvedValue({
    success: true,
    data: { id: "new-id", label: "acme", value: "acme" },
  } as never);
});

describe("Combobox Enter key", () => {
  it("shows a company created by a sibling picker sharing the same options array", async () => {
    const options = [...companies];
    const created = { id: "sibling-company", value: "zebra", label: "Zebra" };
    vi.mocked(addCompany).mockResolvedValue({ success: true, data: created } as never);
    function SharedPickers() {
      const form = useForm({ defaultValues: { company: "", workedAtCompany: "" } });
      return <Form {...form}>{(["company", "workedAtCompany"] as const).map((name) => (
        <FormField key={name} control={form.control} name={name} render={({ field }) => (
          <FormItem><Combobox options={options} field={field} creatable /></FormItem>
        )} />
      ))}</Form>;
    }
    const user = userEvent.setup();
    render(<SharedPickers />);
    await user.click(screen.getAllByRole("combobox")[0]);
    await user.type(screen.getByPlaceholderText(/Search company/i), "Zebra{Enter}");
    await waitFor(() => expect(screen.getAllByRole("combobox")[0]).toHaveTextContent("Zebra"));
    await user.click(screen.getAllByRole("combobox")[1]);
    await user.type(screen.getByPlaceholderText(/Search workedAtCompany/i), "Zebra");
    await user.click(await screen.findByRole("option", { name: "Zebra" }));
    expect(screen.getAllByRole("combobox")[1]).toHaveTextContent("Zebra");
    expect(addCompany).toHaveBeenCalledTimes(1);
  });

  it("preserves a created custom source through rerenders and locale changes", async () => {
    const options = [{ id: "system", value: "careerpage", label: "Company Career page" }];
    const custom = { id: "custom", value: "学校就业群", label: "学校就业群" };
    vi.mocked(createJobSource).mockResolvedValue({ success: true, data: custom } as never);
    function SourceHarness({ locale }: { locale: "en" | "zh-CN" }) {
      const form = useForm({ defaultValues: { source: "" } });
      return <Form {...form}><FormField control={form.control} name="source" render={({ field }) => (
        <FormItem><Combobox options={options} field={field} creatable
          getOptionLabel={(option) => getLocalizedJobSource(option, (key) => translate(locale, key))} /></FormItem>
      )} /></Form>;
    }
    const user = userEvent.setup();
    const { rerender } = render(<SourceHarness locale="zh-CN" />);
    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText("Create or Search source"), "学校就业群{Enter}");
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveTextContent(custom.label));
    rerender(<SourceHarness locale="en" />);
    expect(screen.getByRole("combobox")).toHaveTextContent(custom.label);
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: custom.label })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Official Website" })).toBeInTheDocument();
  });
  describe("creating", () => {
    it("creates a new option when nothing matches the search", async () => {
      const { user, input } = await openCombobox();

      await user.type(input, "Zebra{Enter}");

      await waitFor(() =>
        expect(addCompany).toHaveBeenCalledWith({ company: "Zebra" })
      );
    });

    it("trims surrounding whitespace before creating", async () => {
      const { user, input } = await openCombobox();

      await user.type(input, "  Zebra  {Enter}");

      await waitFor(() =>
        expect(addCompany).toHaveBeenCalledWith({ company: "Zebra" })
      );
    });

    it("selects the created option and closes the popover", async () => {
      const { user, input, onChange } = await openCombobox();

      await user.type(input, "Zebra{Enter}");

      await waitFor(() => expect(onChange).toHaveBeenCalledWith("new-id"));
      await waitFor(() =>
        expect(screen.queryByPlaceholderText(/Search company/i)).toBeNull()
      );
    });

    it("routes to the right action for each field name", async () => {
      vi.mocked(createJobTitle).mockResolvedValue({ id: "t1" } as never);
      const { user, input } = await openCombobox({
        name: "title",
        options: [],
      });

      await user.type(input, "Staff Engineer{Enter}");

      await waitFor(() =>
        expect(createJobTitle).toHaveBeenCalledWith("Staff Engineer")
      );
      expect(addCompany).not.toHaveBeenCalled();
    });

    it("routes activityType to createActivityType", async () => {
      vi.mocked(createActivityType).mockResolvedValue({ id: "a1" } as never);
      const { user, input } = await openCombobox({
        name: "activityType",
        options: [],
      });

      await user.type(input, "Networking{Enter}");

      await waitFor(() =>
        expect(createActivityType).toHaveBeenCalledWith("Networking")
      );
    });

    it("creates a contact role from the typed label", async () => {
      vi.mocked(createContactRole).mockResolvedValue({
        success: true,
        data: { id: "r9", label: "Panel Lead", created: true },
      } as never);
      const { user, input, onChange } = await openCombobox({
        name: "contactRole",
        options: [],
      });

      await user.type(input, "Panel Lead{Enter}");

      await waitFor(() =>
        expect(createContactRole).toHaveBeenCalledWith("Panel Lead")
      );
      expect(onChange).toHaveBeenCalledWith("r9");
    });

    it("creates a company from the worked-together picker", async () => {
      const { user, input, onChange } = await openCombobox({
        name: "workedAtCompany",
        options: [],
      });

      await user.type(input, "Shopify{Enter}");

      await waitFor(() =>
        expect(addCompany).toHaveBeenCalledWith({ company: "Shopify" })
      );
      await waitFor(() => expect(onChange).toHaveBeenCalledWith("new-id"));
    });
  });

  describe("not creating", () => {
    it("does nothing on Enter with an empty input", async () => {
      const { user, input, onChange } = await openCombobox({ options: [] });

      await user.type(input, "{Enter}");

      await new Promise((r) => setTimeout(r, 50));
      expect(addCompany).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("does nothing on Enter with a whitespace-only input", async () => {
      const { user, input, onChange } = await openCombobox({ options: [] });

      await user.type(input, "   {Enter}");

      await new Promise((r) => setTimeout(r, 50));
      expect(addCompany).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("does not create when the combobox is not creatable", async () => {
      const { user, input, onChange } = await openCombobox({
        creatable: false,
        options: [],
      });

      await user.type(input, "Zebra{Enter}");

      await new Promise((r) => setTimeout(r, 50));
      expect(addCompany).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    });

    it("does not create on non-Enter keys", async () => {
      const { user, input } = await openCombobox({ options: [] });

      await user.type(input, "Zebra");
      await user.keyboard("{Escape}");

      await new Promise((r) => setTimeout(r, 50));
      expect(addCompany).not.toHaveBeenCalled();
    });

    it("selects an exact match instead of creating a duplicate", async () => {
      const { user, input, onChange } = await openCombobox();

      await user.type(input, "Acme Corp{Enter}");

      await waitFor(() => expect(onChange).toHaveBeenCalledWith("other-id"));
      expect(addCompany).not.toHaveBeenCalled();
    });

    it("matches case-insensitively when selecting an existing option", async () => {
      const { user, input, onChange } = await openCombobox();

      await user.type(input, "ACME CORP{Enter}");

      await waitFor(() => expect(onChange).toHaveBeenCalledWith("other-id"));
      expect(addCompany).not.toHaveBeenCalled();
    });
  });

  // Tailwind's `capitalize` renders a stored "eBay" as "EBay". jsdom applies
  // no stylesheet, so assert on the class chain around the label instead.
  describe("label casing", () => {
    const trademark = [{ id: "ebay-id", value: "ebay", label: "eBay" }];

    function expectNoCapitalize(el: HTMLElement | null) {
      for (let node = el; node; node = node.parentElement) {
        expect(node.className).not.toMatch(/(^|\s|:)capitalize(\s|$)/);
      }
    }

    it("does not capitalize an option label in the list", async () => {
      await openCombobox({ options: trademark });

      expectNoCapitalize(screen.getByText("eBay"));
    });

    it("does not capitalize the create prompt", async () => {
      const { user, input } = await openCombobox({ options: [] });

      await user.type(input, "eBay");

      expectNoCapitalize(screen.getByText("eBay"));
    });

    it("does not capitalize the selected label on the trigger", async () => {
      const { user } = await openCombobox({ options: trademark });

      await user.click(screen.getByText("eBay"));

      await waitFor(() =>
        expect(screen.queryByPlaceholderText(/Search company/i)).toBeNull()
      );
      expectNoCapitalize(screen.getByText("eBay"));
    });
  });

  describe("preserving cmdk defaults", () => {
    it("still selects an arrow-key highlighted option on Enter", async () => {
      const { user, input, onChange } = await openCombobox();

      await user.type(input, "{ArrowDown}");
      await user.keyboard("{Enter}");

      await waitFor(() => expect(onChange).toHaveBeenCalled());
      expect(addCompany).not.toHaveBeenCalled();
      expect(input).toBeDefined();
    });

    it("is not blocked by a highlighted item in an unrelated cmdk list", async () => {
      const user = userEvent.setup();
      render(
        <>
          {/* A second cmdk list mounted elsewhere in the document, e.g. the
              skills TagInput popover mid-close-animation */}
          <Command>
            <CommandList>
              <CommandGroup>
                <CommandItem value="unrelated">Unrelated</CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
          <Harness onChange={vi.fn()} />
        </>
      );

      await user.click(screen.getByRole("combobox"));
      await user.type(
        screen.getByPlaceholderText(/Search company/i),
        "Zebra{Enter}"
      );

      await waitFor(() =>
        expect(addCompany).toHaveBeenCalledWith({ company: "Zebra" })
      );
    });
  });

  describe("duplicate resolution", () => {
    it("selects the existing company instead of creating a legal-suffix duplicate", async () => {
      const options = [{ id: "acme-id", value: "acme", label: "Acme" }];
      const { user, input, onChange } = await openCombobox({ options });

      // "Acme Inc" canonicalizes to "acme" — the same row addCompany would hit
      await user.type(input, "Acme Inc{Enter}");

      await waitFor(() => expect(onChange).toHaveBeenCalledWith("acme-id"));
      expect(addCompany).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    });

    it("selects the seeded system source an alias resolves to", async () => {
      const options = [
        { id: "careerpage-id", value: "careerpage", label: "Company Career page" },
      ];
      const { user, input, onChange } = await openCombobox({
        name: "source",
        options,
      });

      await user.type(input, "官网{Enter}");

      await waitFor(() => expect(onChange).toHaveBeenCalledWith("careerpage-id"));
      expect(createJobSource).not.toHaveBeenCalled();
    });

    it("does not insert a second row when the server resolves to an existing record", async () => {
      const existing = { id: "t-existing", value: "staff engineer", label: "Staff Engineer" };
      // e.g. a concurrent tab already created it — the action returns that row
      vi.mocked(createJobTitle).mockResolvedValue(existing as never);
      const options = [{ id: "t-existing", value: "staff engineer", label: "Staff Engineer" }];
      const { user, input, onChange } = await openCombobox({
        name: "title",
        options,
      });

      await user.type(input, "Staff Engineer II{Enter}");

      await waitFor(() => expect(onChange).toHaveBeenCalledWith("t-existing"));
      await user.click(screen.getByRole("combobox"));
      expect(
        screen.getAllByRole("option", { name: "Staff Engineer" }),
      ).toHaveLength(1);
    });

    it("trims the CommandEmpty click-path input before creating", async () => {
      const { user, input } = await openCombobox({ options: [] });

      await user.type(input, "  Zebra  ");
      await user.click(screen.getByText("Zebra", { selector: "p" }));

      await waitFor(() =>
        expect(addCompany).toHaveBeenCalledWith({ company: "Zebra" })
      );
    });
  });

  describe("creation failures", () => {
    it.each(["Enter", "click"])("retains the draft after creation fails via %s", async (trigger) => {
      vi.mocked(createJobSource).mockResolvedValue({
        success: false,
        message: "Job source name is too long",
      } as never);
      const { user, input, onChange } = await openCombobox({ name: "source", options: [] });
      const draft = "x".repeat(90);
      await user.type(input, draft);
      if (trigger === "Enter") await user.keyboard("{Enter}");
      else await user.click(screen.getByText(draft, { selector: "p" }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith("Job source name is too long"));
      expect(input).toBeVisible();
      expect(input).toHaveValue(draft);
      expect(onChange).not.toHaveBeenCalled();
    });

    it("surfaces an error toast when location creation fails", async () => {
      vi.mocked(createLocation).mockResolvedValue({
        success: false,
        message: "Location already exists",
        data: undefined,
      } as never);
      const { user, input, onChange } = await openCombobox({
        name: "location",
        options: [],
      });

      await user.type(input, "Toronto{Enter}");

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(onChange).not.toHaveBeenCalled();
    });

    it("does not select anything when the role create fails", async () => {
      vi.mocked(createContactRole).mockResolvedValue({
        success: false,
        message: "Failed to create contact role.",
      } as never);
      const { user, input, onChange } = await openCombobox({
        name: "contactRole",
        options: [],
      });

      await user.type(input, "Oops{Enter}");

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(onChange).not.toHaveBeenCalled();
    });

    it("surfaces an error toast when source creation fails", async () => {
      vi.mocked(createJobSource).mockResolvedValue({
        success: false,
        message: "Source already exists",
        data: undefined,
      } as never);
      const { user, input, onChange } = await openCombobox({
        name: "source",
        options: [],
      });

      await user.type(input, "Referral{Enter}");

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(onChange).not.toHaveBeenCalled();
    });

    it("surfaces an error toast when company creation fails", async () => {
      vi.mocked(addCompany).mockResolvedValue({
        success: false,
        message: "Company already exists!",
      } as never);
      const { user, input, onChange } = await openCombobox({ options: [] });

      await user.type(input, "Zebra{Enter}");

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("Company already exists!")
      );
      expect(onChange).not.toHaveBeenCalled();
    });

    it("surfaces an error toast when job title creation fails", async () => {
      vi.mocked(createJobTitle).mockResolvedValue({
        success: false,
        message: "Failed to create job title. ",
      } as never);
      const { user, input, onChange } = await openCombobox({
        name: "title",
        options: [],
      });

      await user.type(input, "Nope{Enter}");

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(onChange).not.toHaveBeenCalled();
    });

    it("surfaces an error toast when activity type creation throws", async () => {
      vi.mocked(createActivityType).mockRejectedValue(
        new Error("Failed to create activity type. ")
      );
      const { user, input, onChange } = await openCombobox({
        name: "activityType",
        options: [],
      });

      await user.type(input, "Nope{Enter}");

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("Failed to create activity type. ")
      );
      expect(onChange).not.toHaveBeenCalled();
    });

    it("reports instead of silently ignoring an unwired creatable field", async () => {
      const { user, input, onChange } = await openCombobox({
        name: "mysteryField",
        options: [],
      });

      await user.type(input, "Zebra{Enter}");

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});

describe("Combobox freeText", () => {
  const salaries = [
    { id: "Under 50,000", value: "Under 50,000", label: "Under 50,000" },
    {
      id: "100,000 - 110,000",
      value: "100,000 - 110,000",
      label: "100,000 - 110,000",
    },
  ];

  it("stores typed text as the value and calls no create action", async () => {
    const { user, input, onChange } = await openCombobox({
      name: "salaryRange",
      options: salaries,
      freeText: true,
    });

    await user.type(input, "$120k - $150k CAD{Enter}");

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("$120k - $150k CAD")
    );
    expect(addCompany).not.toHaveBeenCalled();
    expect(createJobTitle).not.toHaveBeenCalled();
    expect(createLocation).not.toHaveBeenCalled();
    expect(createJobSource).not.toHaveBeenCalled();
    expect(createActivityType).not.toHaveBeenCalled();
  });

  it("stores the preset text when a suggestion is picked", async () => {
    const { user, onChange } = await openCombobox({
      name: "salaryRange",
      options: salaries,
      freeText: true,
    });

    await user.click(screen.getByRole("option", { name: "100,000 - 110,000" }));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith("100,000 - 110,000")
    );
  });

  it("displays a value that matches no option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        onChange={onChange}
        name="salaryRange"
        options={salaries}
        freeText
      />
    );

    await user.click(screen.getByRole("combobox"));
    const input = screen.getByPlaceholderText(/Search salaryRange/i);
    await user.type(input, "$190k - $220k{Enter}");

    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveTextContent("$190k - $220k")
    );
  });

  it("trims typed text before storing it", async () => {
    const { user, input, onChange } = await openCombobox({
      name: "salaryRange",
      options: salaries,
      freeText: true,
    });

    // CommandEmpty's onClick passes the raw input, unlike the Enter path
    await user.type(input, "  Negotiable  ");
    await user.click(screen.getByText("Negotiable", { selector: "p" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Negotiable"));
  });

  it("keeps the created label on the trigger after a prop-array rebuild", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // Harness re-creates the options array each render, so the unshift into
    // the prop is lost — the local created-options copy must keep the label.
    render(<Harness onChange={onChange} options={companies} />);

    await user.click(screen.getByRole("combobox"));
    const input = screen.getByPlaceholderText(/Search company/i);
    await user.type(input, "Zebra{Enter}");

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("new-id"));
    expect(screen.getByRole("combobox")).toHaveTextContent("acme");
    expect(screen.getByRole("combobox")).not.toHaveTextContent("new-id");
  });
});

describe("Combobox label", () => {
  it("uses the label prop in both placeholders", async () => {
    const user = userEvent.setup();
    render(
      <Harness onChange={vi.fn()} name="salaryRange" label="Salary Range" />
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Select Salary Range");

    await user.click(trigger);
    expect(
      screen.getByPlaceholderText("Create or Search Salary Range")
    ).toBeInTheDocument();
  });

  it("falls back to the field name when no label is given", async () => {
    const user = userEvent.setup();
    render(<Harness onChange={vi.fn()} />);

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Select company");

    await user.click(trigger);
    expect(
      screen.getByPlaceholderText("Create or Search company")
    ).toBeInTheDocument();
  });

  it("localizes the closed and search placeholders when a label is provided", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider initialLocale="zh-CN">
        <Harness onChange={vi.fn()} name="title" label="职位名称" />
      </I18nProvider>,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("选择职位名称");
    await user.click(trigger);
    expect(screen.getByPlaceholderText("创建或搜索职位名称")).toBeInTheDocument();
  });
});

describe("Combobox onSearchChange", () => {
  it("reports what the user types to the caller", async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn();
    render(
      <Harness onChange={vi.fn()} options={[]} onSearchChange={onSearchChange} />
    );

    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByPlaceholderText(/Search company/i), "Ada");

    await waitFor(() => expect(onSearchChange).toHaveBeenCalledWith("Ada"));
  });
});


describe("Combobox disabled and real pending state", () => {
  it("does not open or submit when its form field is disabled", async () => {
    const user = userEvent.setup();
    render(<Harness disabled onChange={vi.fn()} />);
    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("type", "button");
    await user.click(trigger);
    expect(screen.queryByPlaceholderText(/Search company/i)).not.toBeInTheDocument();
  });

  it("blocks repeated creation while the existing transition is pending", async () => {
    let finish!: (value: Awaited<ReturnType<typeof addCompany>>) => void;
    vi.mocked(addCompany).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { user, input, onChange } = await openCombobox();
    await user.type(input, "Synthetic pending company");
    await user.keyboard("{Enter}");
    const trigger = screen.getAllByRole("combobox", { hidden: true }).find(el => el.tagName === "BUTTON")!;
    await waitFor(() => expect(trigger).toBeDisabled());
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(input).toBeDisabled();
    await user.keyboard("{Enter}{Enter}");
    expect(addCompany).toHaveBeenCalledTimes(1);
    finish({ success: true, data: { id: "pending-id", label: "Synthetic pending company", value: "synthetic" } } as never);
    await waitFor(() => expect(trigger).not.toBeDisabled());
    expect(onChange).toHaveBeenCalledWith("pending-id");
  });
});

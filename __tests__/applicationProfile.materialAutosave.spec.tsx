import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import {
  MaterialRecordsSection,
  type MaterialItem,
} from "@/components/career/application-profile/MaterialRecordsSection";

const DETAIL_KEY: Record<string, string> = {
  EDUCATION: "educationDetail",
  INTERNSHIP: "internshipDetail",
  PROJECT: "projectDetail",
  SKILL: "skillDetail",
  CERTIFICATION: "certificationDetail",
};

const materialStore = { current: [] as Record<string, unknown>[] };

vi.mock("@/actions/applicationProfile.actions", () => ({
  createApplicationMaterial: vi.fn(),
  updateApplicationMaterial: vi.fn(
    async (input: { id: string } & Record<string, unknown>) => {
      const { id, detail, ...rest } = input;
      materialStore.current = materialStore.current.map((m) => {
        if (m.id !== id) return m;
        const next = { ...m, ...rest };
        if (detail && typeof detail === "object") {
          const rel = DETAIL_KEY[next.type as string];
          next[rel] = {
            ...((m[rel] as Record<string, unknown>) ?? {}),
            ...detail,
          };
        }
        return next;
      });
      return {
        success: true,
        data: materialStore.current.find((m) => m.id === id),
      };
    },
  ),
  archiveApplicationMaterial: vi.fn(async () => ({
    success: true,
    data: { id: "archived" },
  })),
  addApplicationMaterialEvidence: vi.fn(async () => ({
    success: true,
    data: { id: "ev-1" },
  })),
}));

vi.mock("@/lib/toast", () => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

import {
  addApplicationMaterialEvidence,
  updateApplicationMaterial,
} from "@/actions/applicationProfile.actions";

const mockedUpdate = updateApplicationMaterial as unknown as ReturnType<
  typeof vi.fn
>;
const mockedEvidence = addApplicationMaterialEvidence as unknown as ReturnType<
  typeof vi.fn
>;

function Harness({
  readonlyItems = [],
  readonlyTitle,
}: {
  readonlyItems?: MaterialItem[];
  readonlyTitle?: string;
}) {
  const [items, setItems] = useState<MaterialItem[]>(
    materialStore.current as MaterialItem[],
  );
  return (
    <MaterialRecordsSection
      title="Records"
      items={items}
      creatableTypes={["EDUCATION", "SKILL"]}
      readonlyItems={readonlyItems}
      readonlyTitle={readonlyTitle}
      onChanged={async () => {
        setItems([...materialStore.current] as MaterialItem[]);
      }}
    />
  );
}

function eduItem(): Record<string, unknown> {
  return {
    id: "m-edu",
    type: "EDUCATION",
    title: "Fudan University",
    notes: "old note",
    startDate: "2018-09-01T00:00:00.000Z",
    endDate: "2022-06-30T00:00:00.000Z",
    isCurrent: false,
    educationDetail: {
      institution: "Fudan",
      degree: "Bachelor",
      fieldOfStudy: "CS",
      gpaValue: 3.6,
      gpaScale: 4,
      rankText: "top 5%",
    },
    evidence: [],
  };
}

function field(id: string) {
  return screen.getByTestId(`${id}-input`);
}

function status(id: string) {
  return screen.getByTestId(`${id}-status`);
}

async function renderSection() {
  render(<Harness />);
  await screen.findByTestId("material-m-edu-title-input");
}

describe("MaterialRecordsSection inline autosave", () => {
  beforeEach(() => {
    materialStore.current = [eduItem()];
    mockedUpdate.mockImplementation(
      async (input: { id: string } & Record<string, unknown>) => {
        const { id, detail, ...rest } = input;
        materialStore.current = materialStore.current.map((m) => {
          if (m.id !== id) return m;
          const next = { ...m, ...rest };
          if (detail && typeof detail === "object") {
            const rel = DETAIL_KEY[next.type as string];
            next[rel] = {
              ...((m[rel] as Record<string, unknown>) ?? {}),
              ...detail,
            };
          }
          return next;
        });
        return {
          success: true,
          data: materialStore.current.find((m) => m.id === id),
        };
      },
    );
  });

  it("backfills stored detail values into per-field editors", async () => {
    await renderSection();
    expect(field("material-m-edu-title")).toHaveValue("Fudan University");
    expect(field("material-m-edu-institution")).toHaveValue("Fudan");
    expect(field("material-m-edu-degree")).toHaveValue("Bachelor");
    expect(field("material-m-edu-fieldOfStudy")).toHaveValue("CS");
    expect(field("material-m-edu-gpaValue")).toHaveValue("3.6");
    expect(field("material-m-edu-gpaScale")).toHaveValue("4");
    expect(field("material-m-edu-rankText")).toHaveValue("top 5%");
    expect(field("material-m-edu-startDate")).toHaveValue("2018-09-01");
    expect(field("material-m-edu-endDate")).toHaveValue("2022-06-30");
    expect(field("material-m-edu-notes")).toHaveValue("old note");
    expect(field("material-m-edu-isCurrent")).not.toBeChecked();
  });

  it("commits one detail field on blur and sends only that key", async () => {
    await renderSection();
    const gpa = field("material-m-edu-gpaValue");
    fireEvent.change(gpa, { target: { value: "3.9" } });
    fireEvent.blur(gpa);

    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({
        id: "m-edu",
        detail: { gpaValue: 3.9 },
      }),
    );
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(status("material-m-edu-gpaValue").textContent).toContain("Saved"),
    );
    // Sibling detail fields stay displayed and untouched.
    expect(field("material-m-edu-institution")).toHaveValue("Fudan");
    expect(
      (materialStore.current[0].educationDetail as Record<string, unknown>)
        .gpaValue,
    ).toBe(3.9);
    expect(
      (materialStore.current[0].educationDetail as Record<string, unknown>)
        .institution,
    ).toBe("Fudan");
  });

  it("commits the title on blur and never writes an empty title", async () => {
    await renderSection();
    const title = field("material-m-edu-title");
    fireEvent.change(title, { target: { value: "SJTU" } });
    fireEvent.blur(title);
    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({ id: "m-edu", title: "SJTU" }),
    );

    fireEvent.change(title, { target: { value: "" } });
    fireEvent.blur(title);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    // The draft is kept locally — nothing is silently rewritten.
    expect(title).toHaveValue("");
    expect(materialStore.current[0].title).toBe("SJTU");
  });

  it("clears notes to null and commits dates/isCurrent independently", async () => {
    await renderSection();

    const notes = field("material-m-edu-notes");
    fireEvent.change(notes, { target: { value: "" } });
    fireEvent.blur(notes);
    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({ id: "m-edu", notes: null }),
    );

    const start = field("material-m-edu-startDate");
    fireEvent.change(start, { target: { value: "2020-01-02" } });
    fireEvent.blur(start);
    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({
        id: "m-edu",
        startDate: "2020-01-02",
      }),
    );

    fireEvent.click(field("material-m-edu-isCurrent"));
    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({
        id: "m-edu",
        isCurrent: true,
      }),
    );

    // The end date was never touched by these commits.
    expect(materialStore.current[0].endDate).toBe("2022-06-30T00:00:00.000Z");
  });

  it("keeps the draft on failure and retries on demand", async () => {
    mockedUpdate.mockImplementationOnce(async () => ({
      success: false,
      message: "INVALID_MATERIAL_DETAIL",
    }));
    await renderSection();
    const institution = field("material-m-edu-institution");
    fireEvent.change(institution, { target: { value: "SJTU" } });
    fireEvent.blur(institution);

    await waitFor(() =>
      expect(status("material-m-edu-institution").textContent).toContain(
        "Save failed",
      ),
    );
    expect(institution).toHaveValue("SJTU");
    expect(
      (materialStore.current[0].educationDetail as Record<string, unknown>)
        .institution,
    ).toBe("Fudan");

    fireEvent.click(screen.getByTestId("material-m-edu-institution-retry"));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    expect(mockedUpdate).toHaveBeenLastCalledWith({
      id: "m-edu",
      detail: { institution: "SJTU" },
    });
    await waitFor(() =>
      expect(status("material-m-edu-institution").textContent).toContain(
        "Saved",
      ),
    );
  });

  it("serializes rapid consecutive commits and lands the final value", async () => {
    let resolveFirst!: (v: unknown) => void;
    mockedUpdate
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(
        async (input: { id: string } & Record<string, unknown>) => {
          const { id, detail, ...rest } = input;
          materialStore.current = materialStore.current.map((m) => {
            if (m.id !== id) return m;
            const next = { ...m, ...rest };
            if (detail && typeof detail === "object") {
              const rel = DETAIL_KEY[next.type as string];
              next[rel] = {
                ...((m[rel] as Record<string, unknown>) ?? {}),
                ...detail,
              };
            }
            return next;
          });
          return {
            success: true,
            data: materialStore.current.find((m) => m.id === id),
          };
        },
      );

    await renderSection();
    const title = field("material-m-edu-title");
    fireEvent.change(title, { target: { value: "A" } });
    fireEvent.blur(title);

    await waitFor(() =>
      expect(status("material-m-edu-title").textContent).toContain("Saving"),
    );

    fireEvent.change(title, { target: { value: "AB" } });
    fireEvent.blur(title);

    await act(async () => {
      resolveFirst({ success: true, data: { id: "m-edu", title: "A" } });
    });

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledTimes(2));
    expect(mockedUpdate.mock.calls[0][0]).toEqual({ id: "m-edu", title: "A" });
    expect(mockedUpdate.mock.calls[1][0]).toEqual({ id: "m-edu", title: "AB" });
    await waitFor(() =>
      expect(status("material-m-edu-title").textContent).toContain("Saved"),
    );
    expect(title).toHaveValue("AB");
    expect(materialStore.current[0].title).toBe("AB");
  });

  it("keeps focus and waits for IME completion before saving", async () => {
    await renderSection();
    const title = field("material-m-edu-title");
    title.focus();
    fireEvent.compositionStart(title);
    fireEvent.change(title, { target: { value: "林" }, isComposing: true });
    fireEvent.keyDown(title, {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    expect(title).toHaveFocus();
    expect(mockedUpdate).not.toHaveBeenCalled();
    fireEvent.compositionEnd(title);
    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({ id: "m-edu", title: "林" }),
    );
  });

  it("unmounts without writing a pending draft", async () => {
    const { unmount } = render(<Harness />);
    const title = await screen.findByTestId("material-m-edu-title-input");
    fireEvent.change(title, { target: { value: "Dropped" } });
    unmount();
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("keeps per-record drafts isolated", async () => {
    materialStore.current = [
      eduItem(),
      {
        id: "m-edu-2",
        type: "EDUCATION",
        title: "SJTU",
        notes: null,
        isCurrent: true,
        educationDetail: { institution: "SJTU" },
        evidence: [],
      },
    ];
    await renderSection();
    expect(field("material-m-edu-2-title")).toHaveValue("SJTU");
    fireEvent.change(field("material-m-edu-title"), {
      target: { value: "Edited" },
    });
    fireEvent.blur(field("material-m-edu-title"));
    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({
        id: "m-edu",
        title: "Edited",
      }),
    );
    expect(field("material-m-edu-2-title")).toHaveValue("SJTU");
    expect(materialStore.current[1].title).toBe("SJTU");
  });

  it("keeps EMPLOYMENT and CUSTOM records read-only with copy/archive intact", async () => {
    materialStore.current = [
      {
        id: "m-custom",
        type: "CUSTOM",
        title: "Custom thing",
        notes: "free text",
        evidence: [],
      },
    ];
    render(
      <Harness
        readonlyItems={[
          {
            id: "m-emp",
            type: "EMPLOYMENT",
            title: "Legacy Job",
            notes: null,
          } as MaterialItem,
        ]}
        readonlyTitle="Employment (read-only)"
      />
    );
    await screen.findByText("Custom thing");
    // No autosave inputs are rendered for non-allowlist types.
    expect(screen.queryByTestId("material-m-custom-title-input")).toBeNull();
    expect(screen.queryByTestId("material-m-emp-title-input")).toBeNull();
    expect(screen.getByText("Legacy Job")).toBeInTheDocument();
    expect(screen.getByText("free text")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Archive" }).length,
    ).toBeGreaterThan(0);
  });

  it("renders per-type detail editors (SKILL, CERTIFICATION)", async () => {
    materialStore.current = [
      {
        id: "m-skill",
        type: "SKILL",
        title: "Python",
        notes: null,
        skillDetail: { skillName: "Python", proficiency: "熟练" },
        evidence: [],
      },
      {
        id: "m-cert",
        type: "CERTIFICATION",
        title: "AWS SAA",
        notes: null,
        certificationDetail: {
          organization: "AWS",
          issueDate: "2024-03-01T00:00:00.000Z",
        },
        evidence: [],
      },
    ];
    render(<Harness />);
    await screen.findByTestId("material-m-skill-skillName-input");
    expect(field("material-m-skill-skillName")).toHaveValue("Python");
    expect(field("material-m-skill-proficiency")).toHaveValue("熟练");
    expect(field("material-m-cert-issueDate")).toHaveValue("2024-03-01");
    expect(field("material-m-cert-organization")).toHaveValue("AWS");

    fireEvent.change(field("material-m-skill-proficiency"), {
      target: { value: "精通" },
    });
    fireEvent.blur(field("material-m-skill-proficiency"));
    await waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith({
        id: "m-skill",
        detail: { proficiency: "精通" },
      }),
    );
  });

  it("still supports evidence add and item copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await renderSection();

    fireEvent.change(screen.getByPlaceholderText("Fact"), {
      target: { value: "Dean list 2021" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add fact" }));
    await waitFor(() =>
      expect(mockedEvidence).toHaveBeenCalledWith({
        materialItemId: "m-edu",
        content: "Dean list 2021",
        metricText: null,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy item" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain("Fudan University");
  });
});

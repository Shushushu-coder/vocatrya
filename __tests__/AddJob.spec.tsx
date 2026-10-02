import { AddJob } from "@/components/myjobs/AddJob";
import { JOB_SOURCES } from "@/lib/data/jobSourcesData";
import { JOB_STATUSES } from "@/lib/data/jobStatusesData";
import { getMockJobDetails, getMockList } from "@/lib/mock.utils";
import { screen, render, waitFor } from "@testing-library/react";
import { getCurrentUser } from "@/utils/user.utils";
import userEvent from "@testing-library/user-event";
import { format } from "date-fns";
import { addJob, updateJob } from "@/actions/job.actions";
import { toastActionResult } from "@/lib/toast";
import type { JobResponse } from "@/models/job.model";
import { APP_CONSTANTS } from "@/lib/constants";
import { I18nProvider } from "@/i18n/context";
vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/actions/job.actions", () => ({
  addJob: vi.fn().mockResolvedValue({ success: true }),
  updateJob: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/actions/note.actions", () => ({
  getNotesByJobId: vi.fn().mockResolvedValue({ success: true, data: [] }),
  addNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toastActionResult: vi.fn((result, opts) => {
    if (result?.success) opts.onSuccess?.(result.data);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({ replace: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

document.createRange = () => {
  const range = new Range();

  range.getBoundingClientRect = vi.fn().mockReturnValue({
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
  });

  range.getClientRects = () => {
    return {
      item: () => null,
      length: 0,
      [Symbol.iterator]: vi.fn(),
    };
  };

  return range;
};

describe("AddJob Component", () => {
  const mockUser = { id: "user-id" };
  const mockJobStatuses = JOB_STATUSES;
  const mockJobSources = JOB_SOURCES;
  const mockResetEditJob = vi.fn();
  const user = userEvent.setup({ skipHover: true });
  window.HTMLElement.prototype.scrollIntoView = vi.fn(); // Fixes the issue with combobox
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();

  beforeEach(async () => {
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    vi.clearAllMocks();
    render(
      <AddJob
        jobStatuses={mockJobStatuses}
        companies={mockCompanies}
        jobTitles={mockJobTitles}
        locations={mockLocations}
        jobSources={mockJobSources}
        tags={[]}
        editJob={null}
        resetEditJob={mockResetEditJob}
      />,
    );
    const addJobButton = screen.getByTestId("add-job-btn");
    await user.click(addJobButton);
  });

  it("should open the dialog when clicked on add job button with title 'Add Job'", async () => {
    (getCurrentUser as any).mockResolvedValue(mockUser);

    const dialogTitle = screen.getByTestId("add-job-dialog-title");
    expect(dialogTitle).toBeInTheDocument();
    expect(dialogTitle).toHaveTextContent("Add Job");
  });
  it("should set Applied status and date applied when applied switch toggles on", async () => {
    const appliedSwitch = screen.getByRole("switch");
    expect(appliedSwitch).not.toBeChecked();
    const dateApplied = screen.getByLabelText("Date Applied");
    expect(dateApplied).toBeDisabled();
    await user.click(appliedSwitch); // toggle applied switch
    expect(appliedSwitch).toBeChecked();
    expect(dateApplied).toBeEnabled(); // date applied is enabled
    expect(dateApplied).toHaveTextContent(format(new Date(), "PP")); // to have today's date
    const status = screen.getByLabelText("Status");
    expect(status).toHaveTextContent("Applied");
    // applied is an irreversible historical fact — the control locks on
    expect(appliedSwitch).toBeDisabled();
  });

  it("should default the status to New", async () => {
    const status = screen.getByLabelText("Status");
    expect(status).toHaveTextContent("New");
  });

  it("should default to New regardless of the status list order", async () => {
    // Regression guard for relying on jobStatuses[0]: render with a list
    // whose physical order does not start with "new".
    const scrambled = [...JOB_STATUSES].reverse();
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    render(
      <AddJob
        jobStatuses={scrambled}
        companies={mockCompanies}
        jobTitles={mockJobTitles}
        locations={mockLocations}
        jobSources={JOB_SOURCES}
        tags={[]}
        editJob={null}
        resetEditJob={mockResetEditJob}
        initialOpen={true}
      />,
    );
    const statuses = screen.getAllByLabelText("Status");
    expect(statuses[statuses.length - 1]).toHaveTextContent("New");
  });

  it("should keep a later-stage status when marking applied on an un-applied job", async () => {
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    const interviewStatus = JOB_STATUSES.find((s) => s.value === "interview")!;
    const interviewJob = {
      id: "job-interview-1",
      userId: "user-id",
      JobTitle: { id: "1xx", label: "Full Stack Developer", value: "full stack developer" },
      Company: { id: "2zz", label: "Amazon", value: "amazon", logoUrl: "" },
      Location: { id: "1yy", label: "Remote", value: "remote" },
      JobSource: { id: "1359dac4-a397-4461-b747-382706dcbe79", label: "Indeed", value: "indeed" },
      Status: { id: interviewStatus.id, label: "Interview", value: "interview" },
      jobType: "FT",
      createdAt: new Date("2024-06-01"),
      appliedDate: null,
      dueDate: null,
      salaryRange: null,
      description: "<p>Existing job description</p>",
      jobUrl: "",
      applied: false,
    } as unknown as JobResponse;
    render(
      <AddJob
        jobStatuses={mockJobStatuses}
        companies={mockCompanies}
        jobTitles={mockJobTitles}
        locations={mockLocations}
        jobSources={mockJobSources}
        tags={[]}
        editJob={interviewJob}
        resetEditJob={mockResetEditJob}
      />,
    );

    const appliedSwitch = screen.getAllByRole("switch").at(-1)!;
    expect(appliedSwitch).not.toBeChecked();
    await user.click(appliedSwitch);

    const statuses = screen.getAllByLabelText("Status");
    expect(statuses[statuses.length - 1]).toHaveTextContent("Interview");
    expect(appliedSwitch).toBeChecked();
  });
  it("should open the dialog when clicked on add job button with title 'Edit Job'", async () => {
    // TODO: To be tested with job container and jobs table component
  });

  it("should open the dialog immediately when initialOpen is true", async () => {
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    render(
      <AddJob
        jobStatuses={mockJobStatuses}
        companies={mockCompanies}
        jobTitles={mockJobTitles}
        locations={mockLocations}
        jobSources={mockJobSources}
        tags={[]}
        editJob={null}
        resetEditJob={mockResetEditJob}
        initialOpen={true}
      />,
    );
    const dialogTitle = screen.getAllByTestId("add-job-dialog-title")[0];
    expect(dialogTitle).toBeInTheDocument();
    expect(dialogTitle).toHaveTextContent("Add Job");
  });
  it("should show relevant react-hook-form errors", async () => {
    const saveBtn = screen.getByTestId("save-job-btn");
    await user.click(saveBtn);
    expect(screen.getByText("Job title is required.")).toBeInTheDocument();
    expect(screen.getByText("Company name is required.")).toBeInTheDocument();
    expect(screen.getByText("Location is required.")).toBeInTheDocument();
    expect(screen.getByText("Source is required.")).toBeInTheDocument();
  });
  it("should close the dialog when clicked on cancel button", async () => {
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    const dialog = await screen.findByRole("dialog");
    await user.click(cancelBtn);
    expect(dialog).not.toBeInTheDocument();
  });
  it("should load and show the job title combobox list", async () => {
    const jobTitleCombobox = screen.getByLabelText("Job Title");
    await user.click(jobTitleCombobox);
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].textContent).toBe("Frontend Developer");
  });
  it("should load and show the company combobox list", async () => {
    const companyCombobox = screen.getByLabelText("Company");
    await user.click(companyCombobox);
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].textContent).toBe("Google");
  });
  it("should load and show the location combobox list", async () => {
    const locationCombobox = screen.getByLabelText("Job Location");
    await user.click(locationCombobox);
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].textContent).toBe("San Francisco");
  });
  it("should load and show the job source combobox list", async () => {
    const sourceCombobox = screen.getByLabelText("Job Source");
    await user.click(sourceCombobox);
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].textContent).toBe("Indeed");
    for (const name of ["Official Website", "Shixiseng", "BOSS Zhipin", "Referral Group", "Xiaohongshu"]) {
      expect(screen.getByRole("option", { name })).toBeInTheDocument();
    }
  });
  it("should load and show the salary range suggestions", async () => {
    const salaryRangeCombobox = screen.getByLabelText("Salary Range");
    await user.click(salaryRangeCombobox);
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].textContent).toBe("Under 50,000");
    expect(options.at(-1)!.textContent).toBe("300,000+");
  });

  it("should accept a typed salary that is not in the suggestions", async () => {
    const salaryRangeCombobox = screen.getByLabelText("Salary Range");
    await user.click(salaryRangeCombobox);
    const input = screen.getByPlaceholderText("Create or Search Salary Range");
    await user.type(input, "$185k - $210k{Enter}");

    await waitFor(() =>
      expect(screen.getByLabelText("Salary Range")).toHaveTextContent(
        "$185k - $210k",
      ),
    );
  });
  it("offers internship as a job type", () => {
    expect(screen.getByRole("radio", { name: "Internship" })).toBeInTheDocument();
  });

  it("should load and show the status select list", async () => {
    const statusSelect = screen.getByLabelText("Status");
    await user.click(statusSelect);
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].textContent).toBe("New");
  });
  it("should closes the dialog and submit to save job when clicked on save button", async () => {
    const jobTitleInput = screen.getByRole("combobox", {
      name: /job title/i,
    }) as HTMLSelectElement;
    await user.click(jobTitleInput);
    const selectedJobTitle = screen.getByRole("option", {
      name: "Full Stack Developer",
    });
    await user.click(selectedJobTitle);

    const companyInput = screen.getByRole("combobox", { name: /company/i });
    await user.click(companyInput);
    const selectedCompany = screen.getByRole("option", {
      name: "Amazon",
    });
    await user.click(selectedCompany);

    const locationInput = screen.getByRole("combobox", {
      name: /job location/i,
    });
    await user.click(locationInput);
    const selectedLocation = screen.getByRole("option", {
      name: "Remote",
    });
    await user.click(selectedLocation);

    const sourceInput = screen.getByRole("combobox", {
      name: /job source/i,
    });
    await user.click(sourceInput);
    const selectedSource = screen.getByRole("option", {
      name: "Indeed",
    });
    await user.click(selectedSource);

    const editableDiv = screen.getByLabelText("Job Description");
    const pTag = editableDiv.querySelector("div > p");
    if (pTag) {
      pTag.textContent = "New Job Description";
    }

    const dialog = await screen.findByRole("dialog");
    const saveBtn = screen.getByTestId("save-job-btn");
    await user.click(saveBtn);

    await waitFor(() => {
      expect(addJob).toHaveBeenCalledTimes(1);
      expect(dialog).not.toBeInTheDocument();
      expect(addJob).toHaveBeenCalledWith({
        title: "1xx",
        company: "2zz",
        location: "1yy",
        type: "FT",
        workplaceType: "ONSITE",
        source: "1359dac4-a397-4461-b747-382706dcbe79",
        status: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        dueDate: expect.any(Date),
        dateApplied: undefined,
        salaryRange: "",
        jobDescription: "<p>New Job Description</p>",
        jobUrl: "",
        applied: false,
        tags: [],
      });
    });
  }, 10000);
});

describe("AddJob Component - Last Used Location/Source", () => {
  const mockJobStatuses = JOB_STATUSES;
  const mockJobSources = JOB_SOURCES;
  const mockResetEditJob = vi.fn();
  const user = userEvent.setup({ skipHover: true });

  const renderAddJob = async () => {
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    render(
      <AddJob
        jobStatuses={mockJobStatuses}
        companies={mockCompanies}
        jobTitles={mockJobTitles}
        locations={mockLocations}
        jobSources={mockJobSources}
        tags={[]}
        editJob={null}
        resetEditJob={mockResetEditJob}
      />,
    );
    const addJobButton = screen.getByTestId("add-job-btn");
    await user.click(addJobButton);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("pre-fills location and source from a valid last-used id in localStorage", async () => {
    localStorage.setItem(
      APP_CONSTANTS.LAST_JOB_LOCATION_STORAGE_KEY,
      JSON.stringify("1yy"),
    );
    localStorage.setItem(
      APP_CONSTANTS.LAST_JOB_SOURCE_STORAGE_KEY,
      JSON.stringify("1359dac4-a397-4461-b747-382706dcbe79"),
    );
    await renderAddJob();

    expect(screen.getByLabelText("Job Location")).toHaveTextContent("Remote");
    expect(screen.getByLabelText("Job Source")).toHaveTextContent("Indeed");
  });

  it("uses one restrained overlay and English placeholders", async () => {
    await renderAddJob();

    const overlays = document.querySelectorAll("div.fixed.inset-0");
    expect(overlays).toHaveLength(1);
    expect(overlays[0].className).toContain("bg-black/30");
    expect(overlays[0].className).not.toContain("bg-black/80");

    expect(screen.getByLabelText("Job Title")).toHaveTextContent("Select Job Title");
    expect(screen.getByLabelText("Company")).toHaveTextContent("Select Company");
    expect(screen.getByLabelText("Job Location")).toHaveTextContent(
      "Select Job Location",
    );
    expect(screen.getByLabelText("Job Source")).toHaveTextContent(
      "Select Job Source",
    );
    expect(screen.getByLabelText("Salary Range")).toHaveTextContent(
      "Select Salary Range",
    );
    expect(screen.getByLabelText("Resume")).toHaveTextContent("Select Resume");
    expect(screen.getByLabelText("Cover Letter")).toHaveTextContent(
      "Select Cover Letter",
    );

    await user.click(screen.getByLabelText("Job Title"));
    expect(
      screen.getByPlaceholderText("Create or Search Job Title"),
    ).toBeInTheDocument();
  });

  it("ignores a last-used id that no longer exists, e.g. the entity was deleted", async () => {
    localStorage.setItem(
      APP_CONSTANTS.LAST_JOB_LOCATION_STORAGE_KEY,
      JSON.stringify("deleted-location-id"),
    );
    localStorage.setItem(
      APP_CONSTANTS.LAST_JOB_SOURCE_STORAGE_KEY,
      JSON.stringify("deleted-source-id"),
    );
    await renderAddJob();

    expect(screen.getByLabelText("Job Location")).toHaveTextContent(
      "Select Job Location",
    );
    expect(screen.getByLabelText("Job Source")).toHaveTextContent(
      "Select Job Source",
    );
  });

  it("saves the selected location and source to localStorage after a successful save", async () => {
    await renderAddJob();

    await user.click(screen.getByRole("combobox", { name: /job title/i }));
    await user.click(
      screen.getByRole("option", { name: "Full Stack Developer" }),
    );

    await user.click(screen.getByRole("combobox", { name: /company/i }));
    await user.click(screen.getByRole("option", { name: "Amazon" }));

    await user.click(
      screen.getByRole("combobox", { name: /job location/i }),
    );
    await user.click(screen.getByRole("option", { name: "Remote" }));

    await user.click(
      screen.getByRole("combobox", { name: /job source/i }),
    );
    await user.click(screen.getByRole("option", { name: "Indeed" }));

    await user.click(screen.getByTestId("save-job-btn"));

    await waitFor(() => {
      expect(localStorage.getItem(APP_CONSTANTS.LAST_JOB_LOCATION_STORAGE_KEY)).toBe(
        JSON.stringify("1yy"),
      );
      expect(localStorage.getItem(APP_CONSTANTS.LAST_JOB_SOURCE_STORAGE_KEY)).toBe(
        JSON.stringify("1359dac4-a397-4461-b747-382706dcbe79"),
      );
    });
  }, 10000);
});

describe("AddJob Component - Edit Mode", () => {
  const mockJobStatuses = JOB_STATUSES;
  const mockJobSources = JOB_SOURCES;
  const mockResetEditJob = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();

  const editJob = {
    id: "job-edit-1",
    userId: "user-id",
    JobTitle: { id: "1xx", label: "Full Stack Developer", value: "full stack developer" },
    Company: { id: "2zz", label: "Amazon", value: "amazon", logoUrl: "" },
    Location: { id: "1yy", label: "Remote", value: "remote" },
    JobSource: { id: "1359dac4-a397-4461-b747-382706dcbe79", label: "Indeed", value: "indeed" },
    Status: { id: "5e7c6e8c-83e6-46e3-bf01-db8f0b503399", label: "Applied", value: "applied" },
    jobType: "FT",
    createdAt: new Date("2024-06-01"),
    appliedDate: new Date("2024-06-05"),
    dueDate: new Date("2024-06-20"),
    salaryRange: "100,000 - 110,000",
    description: "<p>Existing job description</p>",
    jobUrl: "https://example.com/job",
    applied: true,
  } as unknown as JobResponse;

  async function renderEditMode(overrides: Partial<JobResponse> = {}) {
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    vi.clearAllMocks();
    return render(
      <AddJob
        jobStatuses={mockJobStatuses}
        companies={mockCompanies}
        jobTitles={mockJobTitles}
        locations={mockLocations}
        jobSources={mockJobSources}
        tags={[]}
        editJob={{ ...editJob, ...overrides }}
        resetEditJob={mockResetEditJob}
      />,
    );
  }

  it("opens automatically with title 'Edit Job' and pre-fills the form from editJob", async () => {
    await renderEditMode();

    const dialogTitle = screen.getByTestId("add-job-dialog-title");
    expect(dialogTitle).toHaveTextContent("Edit Job");

    expect(screen.getByLabelText("Job Title")).toHaveTextContent(
      "Full Stack Developer",
    );
    expect(screen.getByLabelText("Company")).toHaveTextContent("Amazon");
    expect(screen.getByLabelText("Job Location")).toHaveTextContent("Remote");
    expect(screen.getByLabelText("Job Source")).toHaveTextContent("Indeed");
    expect(screen.getByLabelText("Status")).toHaveTextContent("Applied");
    expect(screen.getByLabelText("Job URL")).toHaveValue(
      "https://example.com/job",
    );
    expect(screen.getByLabelText("Salary Range")).toHaveTextContent(
      "100,000 - 110,000",
    );

    const appliedSwitch = screen.getByRole("switch");
    expect(appliedSwitch).toBeChecked();
    // Already-applied history cannot be un-applied from the edit form.
    expect(appliedSwitch).toBeDisabled();
  });

  it("pre-fills a free-text salary that matches no suggestion", async () => {
    await renderEditMode({ salaryRange: "$190k – $220k" } as Partial<JobResponse>);

    expect(screen.getByLabelText("Salary Range")).toHaveTextContent(
      "$190k – $220k",
    );
  });

  it("restores internship when editing", async () => {
    await renderEditMode({ jobType: "INTERNSHIP" } as Partial<JobResponse>);
    expect(screen.getByRole("radio", { name: "Internship" })).toBeChecked();
  });

  it("leaves workplace type unselected when editing a job with no workplaceType", async () => {
    await renderEditMode();

    await waitFor(() => {
      expect(screen.getByTestId("add-job-dialog-title")).toHaveTextContent(
        "Edit Job",
      );
    });

    const workplaceRadios = screen
      .getAllByRole("radio")
      .filter((radio) =>
        ["REMOTE", "HYBRID", "ONSITE"].includes(
          radio.getAttribute("value") || "",
        ),
      );
    expect(workplaceRadios).toHaveLength(3);
    workplaceRadios.forEach((radio) => expect(radio).not.toBeChecked());
  });

  it("calls updateJob (not addJob) with the job id when saving an edited job", async () => {
    await renderEditMode();

    await waitFor(() => {
      expect(screen.getByTestId("add-job-dialog-title")).toHaveTextContent(
        "Edit Job",
      );
    });

    const dialog = await screen.findByRole("dialog");
    const saveBtn = screen.getByTestId("save-job-btn");
    const user = userEvent.setup({ skipHover: true });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(updateJob).toHaveBeenCalledTimes(1);
      expect(addJob).not.toHaveBeenCalled();
      expect(dialog).not.toBeInTheDocument();
      expect(updateJob).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "job-edit-1",
          title: "1xx",
          company: "2zz",
          location: "1yy",
          source: "1359dac4-a397-4461-b747-382706dcbe79",
          status: "5e7c6e8c-83e6-46e3-bf01-db8f0b503399",
        }),
      );
    });
  });
});

describe("AddJob A+B unsupported fields", () => {
  const mockJobStatuses = JOB_STATUSES;
  const mockJobSources = JOB_SOURCES;
  const mockResetEditJob = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();

  it("hides resume, cover letter and tags in A+B mode", async () => {
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    render(
      <AddJob
        jobStatuses={mockJobStatuses}
        companies={mockCompanies}
        jobTitles={mockJobTitles}
        locations={mockLocations}
        jobSources={mockJobSources}
        tags={[]}
        editJob={null}
        resetEditJob={mockResetEditJob}
        initialOpen={true}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="full"
      />,
    );

    expect(
      screen.getByText(/not available in A\+B mode yet/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /select resume/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /select cover letter/i }),
    ).not.toBeInTheDocument();
  });

  it("does not default a fake due date in A+B mode", async () => {
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    render(
      <AddJob
        jobStatuses={mockJobStatuses}
        companies={mockCompanies}
        jobTitles={mockJobTitles}
        locations={mockLocations}
        jobSources={mockJobSources}
        tags={[]}
        editJob={null}
        resetEditJob={mockResetEditJob}
        initialOpen={true}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="full"
      />,
    );
    expect(screen.getByLabelText(/due date/i)).toHaveTextContent("Pick a date");
  });

  it("shows optional recruitment cohort and batch fields in A+B mode", async () => {
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    render(
      <AddJob
        jobStatuses={mockJobStatuses}
        companies={mockCompanies}
        jobTitles={mockJobTitles}
        locations={mockLocations}
        jobSources={mockJobSources}
        tags={[]}
        editJob={null}
        resetEditJob={mockResetEditJob}
        initialOpen={true}
        careerRuntimeMode="AB_ENABLED"
        abRolloutScope="full"
      />,
    );
    expect(screen.getByLabelText(/recruitment cohort/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/recruitment batch/i)).toBeInTheDocument();
  });
});

describe("AddJob Component - Error Handling", () => {
  const mockJobStatuses = JOB_STATUSES;
  const mockJobSources = JOB_SOURCES;
  const mockResetEditJob = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();

  it("shows a destructive toast when addJob fails", async () => {
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    vi.clearAllMocks();
    (addJob as any).mockResolvedValueOnce({
      success: false,
      message: "Failed to save job",
    });

    render(
      <AddJob
        jobStatuses={mockJobStatuses}
        companies={mockCompanies}
        jobTitles={mockJobTitles}
        locations={mockLocations}
        jobSources={mockJobSources}
        tags={[]}
        editJob={null}
        resetEditJob={mockResetEditJob}
      />,
    );
    const user = userEvent.setup({ skipHover: true });
    await user.click(screen.getByTestId("add-job-btn"));

    const jobTitleInput = screen.getByRole("combobox", { name: /job title/i });
    await user.click(jobTitleInput);
    await user.click(screen.getByRole("option", { name: "Full Stack Developer" }));

    const companyInput = screen.getByRole("combobox", { name: /company/i });
    await user.click(companyInput);
    await user.click(screen.getByRole("option", { name: "Amazon" }));

    const locationInput = screen.getByRole("combobox", { name: /job location/i });
    await user.click(locationInput);
    await user.click(screen.getByRole("option", { name: "Remote" }));

    const sourceInput = screen.getByRole("combobox", { name: /job source/i });
    await user.click(sourceInput);
    await user.click(screen.getByRole("option", { name: "Indeed" }));

    const editableDiv = screen.getByLabelText("Job Description");
    const pTag = editableDiv.querySelector("div > p");
    if (pTag) {
      pTag.textContent = "Some description";
    }

    await user.click(screen.getByTestId("save-job-btn"));

    await waitFor(() => {
      expect(toastActionResult).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, message: "Failed to save job" }),
        expect.objectContaining({ success: "Job has been created successfully" }),
      );
    });
  }, 10000);
});

describe("AddJob Component - Localized validation (zh-CN)", () => {
  const mockJobStatuses = JOB_STATUSES;
  const mockJobSources = JOB_SOURCES;
  const mockResetEditJob = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();

  it("shows Chinese required-field messages under the zh-CN locale", async () => {
    // Earlier tests may leave a last-used location/source in localStorage,
    // which pre-fills those fields and skips their required validation.
    localStorage.clear();
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    const user = userEvent.setup({ skipHover: true });
    render(
      <I18nProvider initialLocale="zh-CN">
        <AddJob
          jobStatuses={mockJobStatuses}
          companies={mockCompanies}
          jobTitles={mockJobTitles}
          locations={mockLocations}
          jobSources={mockJobSources}
          tags={[]}
          editJob={null}
          resetEditJob={mockResetEditJob}
          initialOpen={true}
        />
      </I18nProvider>,
    );

    await user.click(screen.getByTestId("save-job-btn"));

    // Required-field errors must be localized, never raw English zod strings.
    await waitFor(() => {
      expect(screen.getByText("职位名称为必填项。")).toBeInTheDocument();
    });
    expect(screen.getByText("公司名称为必填项。")).toBeInTheDocument();
    expect(screen.getByText("工作地点为必填项。")).toBeInTheDocument();
    expect(screen.getByText("职位来源为必填项。")).toBeInTheDocument();
    expect(
      screen.queryByText("Job title is required."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Company name is required."),
    ).not.toBeInTheDocument();
  });

  it("shows Chinese placeholders and a single overlay", async () => {
    localStorage.clear();
    const mockCompanies = (await getMockList(1, 10, "companies")).data;
    const mockJobTitles = (await getMockList(1, 10, "jobTitles")).data;
    const mockLocations = (await getMockList(1, 10, "locations")).data;
    const user = userEvent.setup({ skipHover: true });
    render(
      <I18nProvider initialLocale="zh-CN">
        <AddJob
          jobStatuses={mockJobStatuses}
          companies={mockCompanies}
          jobTitles={mockJobTitles}
          locations={mockLocations}
          jobSources={mockJobSources}
          tags={[]}
          editJob={null}
          resetEditJob={mockResetEditJob}
          initialOpen={true}
        />
      </I18nProvider>,
    );

    const overlays = document.querySelectorAll("div.fixed.inset-0");
    expect(overlays).toHaveLength(1);
    expect(overlays[0].className).toContain("bg-black/30");

    expect(screen.getByLabelText("职位名称")).toHaveTextContent("选择职位名称");
    expect(screen.getByLabelText("公司")).toHaveTextContent("选择公司");
    expect(screen.getByLabelText("工作地点")).toHaveTextContent("选择工作地点");
    expect(screen.getByLabelText("求职渠道")).toHaveTextContent("选择求职渠道");
    expect(screen.getByLabelText("薪资范围")).toHaveTextContent("选择薪资范围");
    expect(screen.getByLabelText("简历")).toHaveTextContent("选择简历");
    expect(screen.getByLabelText("求职信")).toHaveTextContent("选择求职信");
    expect(screen.queryByText("Select title")).not.toBeInTheDocument();
    expect(screen.queryByText("创建或搜索title")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("职位名称"));
    expect(screen.getByPlaceholderText("创建或搜索职位名称")).toBeInTheDocument();
  });
});

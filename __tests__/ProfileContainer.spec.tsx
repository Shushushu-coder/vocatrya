import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProfileContainer from "@/components/profile/ProfileContainer";
import React from "react";

let searchParams = new URLSearchParams();
const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace }),
  usePathname: () => "/",
  useSearchParams: () => searchParams,
}));

beforeEach(() => { searchParams = new URLSearchParams(); });

it("ignores the removed toolbar upload deep link", async () => {
  searchParams = new URLSearchParams("import-resume=true");
  await act(async () => { render(<ProfileContainer />); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(replace).not.toHaveBeenCalled();
});

it("does not open legacy upload when the editor is read-only", async () => {
  searchParams = new URLSearchParams("import-resume=true");
  await act(async () => { render(<ProfileContainer resumeReadOnly />); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: vi.fn().mockResolvedValue({ success: false }),
}));

vi.mock("@/actions/profile.actions", () => ({
  getResumeList: vi.fn(() =>
    Promise.resolve({
      data: [],
      total: 0,
      success: true,
      message: "",
    }),
  ),
  getDefaultResumeId: vi.fn(() => Promise.resolve(null)),
  getDefaultContactInfo: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/actions/coverLetter.actions", () => ({
  getCoverLetterList: vi.fn(() =>
    Promise.resolve({
      data: [],
      total: 0,
      success: true,
      message: "",
    }),
  ),
}));

describe("ProfileContainer Component", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await act(async () => {
      render(<ProfileContainer />);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });
  it("should render the profile container component", () => {
    expect(screen.getByText(/profile/i)).toBeInTheDocument();
  });

  it("should open the create resume dialog upon clicking create resume button", async () => {
    const user = userEvent.setup();

    const newButton = screen.getByRole("button", {
      name: /new/i,
    });
    await user.click(newButton);

    const addResumeItem = await screen.findByText(/add new resume/i);
    await user.click(addResumeItem);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /create resume/i }),
    ).toBeInTheDocument();
  });
});

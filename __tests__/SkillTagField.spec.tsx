import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillTagField } from "@/components/career/application-profile/SkillTagField";
import { getAllTags } from "@/actions/tag.actions";
import { setApplicationSkillTag } from "@/actions/applicationProfile.actions";

vi.mock("@/actions/tag.actions", () => ({ getAllTags: vi.fn() }));
vi.mock("@/actions/applicationProfile.actions", () => ({ setApplicationSkillTag: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toastError: vi.fn() }));
vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/career/application-profile/MaterialAutosaveField", () => ({
  MaterialTextField: ({ committed }: { committed: string }) => <input aria-label="Skill text" defaultValue={committed} />,
}));
vi.mock("@/components/myjobs/TagInput", () => ({
  TagInput: ({ selectedTagIds, onChange }: { selectedTagIds: string[]; onChange: (ids: string[]) => void }) => (
    <><span data-testid="selection">{selectedTagIds.join(",")}</span><button type="button" onClick={() => onChange(["tag-1"])}>Choose tag</button></>
  ),
}));

const tag = { id: "tag-1", label: "React", value: "react" };
const load = vi.mocked(getAllTags);
const save = vi.mocked(setApplicationSkillTag);
function setup(linked = false) {
  const onChanged = vi.fn();
  render(<SkillTagField materialId="material-1" tag={linked ? tag : null} skillName="Original" label="Skill" onSaveSkillName={vi.fn()} onChanged={onChanged} />);
  return onChanged;
}
beforeEach(() => {
  vi.resetAllMocks();
  load.mockResolvedValue([tag] as never);
  save.mockResolvedValue({ success: true } as never);
});

it("catches tag-list network failures and allows retry", async () => {
  load.mockRejectedValueOnce(new Error("offline"));
  setup();
  fireEvent.click(await screen.findByRole("button", { name: "common.retry" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("button", { name: "common.retry" })).not.toBeInTheDocument());
});

it("retains a failed selection and retries the same tag", async () => {
  save.mockRejectedValueOnce(new Error("offline"));
  const changed = setup();
  fireEvent.click(screen.getByRole("button", { name: "Choose tag" }));
  const retry = await screen.findByRole("button", { name: "common.retry" });
  expect(screen.getByTestId("selection")).toHaveTextContent("tag-1");
  expect(changed).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenNthCalledWith(2, { id: "material-1", tagId: "tag-1" });
});

it("catches unlink failures and retries without losing the live label", async () => {
  save.mockRejectedValueOnce(new Error("offline"));
  const changed = setup(true);
  fireEvent.click(screen.getByRole("button", { name: "jobs.removeNamed" }));
  fireEvent.click(await screen.findByRole("button", { name: "common.retry" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(save).toHaveBeenLastCalledWith({ id: "material-1", tagId: null });
  expect(screen.getByText("React")).toBeInTheDocument();
});

it("blocks duplicate submissions and text editing while a link is pending", async () => {
  let finish!: (value: never) => void;
  save.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  setup();
  const choose = screen.getByRole("button", { name: "Choose tag" });
  fireEvent.click(choose);
  fireEvent.click(choose);
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("textbox", { name: "Skill text" })).toBeDisabled();
  await act(async () => finish({ success: true } as never));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Skill text" })).not.toBeDisabled());
});

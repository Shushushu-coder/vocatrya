// UI-RC-AVATAR: the person icon is replaced by the trimmed nickname's first
// character — ASCII letters uppercased, Han ideographs and digits kept;
// anything else and an empty nickname keep the person icon. The avatar
// derives from the current user record on every render, so a nickname change
// is reflected without a sign-out.
import { render, screen } from "@testing-library/react";
import UserAvatar, { avatarInitial } from "@/components/UserAvatar";

const makeUser = (name: string) => ({
  id: "1",
  name,
  email: "user@example.com",
});

describe("avatarInitial", () => {
  it.each([
    ["alice", "A"],
    ["Alice", "A"],
    ["  bob  ", "B"],
    ["小明", "小"],
    [" 小明 ", "小"],
    ["7天", "7"],
    ["007", "0"],
  ])("derives %s → %s", (name, expected) => {
    expect(avatarInitial(name)).toBe(expected);
  });

  // Non-English letters, symbols, emoji and whitespace-only names all keep
  // the person icon; the email is never substituted.
  it.each([
    "",
    "   ",
    "@name",
    "#tag",
    "😀abc",
    "_x",
    "-dash",
    "Émile",
  ])("falls back to the icon for %s", (name) => {
    expect(avatarInitial(name)).toBeNull();
  });

  it("returns null for nullish names", () => {
    expect(avatarInitial(null)).toBeNull();
    expect(avatarInitial(undefined)).toBeNull();
  });
});

describe("UserAvatar", () => {
  it("shows the uppercased first letter for an English nickname", () => {
    render(<UserAvatar user={makeUser("alice")} />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("shows the first character for a Chinese nickname", () => {
    render(<UserAvatar user={makeUser("小明")} />);
    expect(screen.getByText("小")).toBeInTheDocument();
  });

  it("keeps a leading digit", () => {
    render(<UserAvatar user={makeUser("7号")} />);
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("trims surrounding whitespace before taking the first character", () => {
    render(<UserAvatar user={makeUser("  alice ")} />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it.each(["@name", "", "   "])(
    "keeps the person icon for the %s nickname",
    (name) => {
      const { container } = render(<UserAvatar user={makeUser(name)} />);
      expect(container.querySelector("svg")).not.toBeNull();
    },
  );

  it("renders nothing without a user", () => {
    const { container } = render(<UserAvatar user={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("reflects a nickname change on rerender without a new session", () => {
    const { rerender } = render(<UserAvatar user={makeUser("alice")} />);
    expect(screen.getByText("A")).toBeInTheDocument();

    rerender(<UserAvatar user={makeUser("小明")} />);
    expect(screen.queryByText("A")).not.toBeInTheDocument();
    expect(screen.getByText("小")).toBeInTheDocument();
  });
});

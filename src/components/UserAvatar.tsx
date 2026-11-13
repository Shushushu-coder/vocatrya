import { User } from "lucide-react";
import { CurrentUser } from "@/models/user.model";
import { Avatar, AvatarFallback } from "./ui/avatar";

// UI-RC-AVATAR: the trimmed nickname's first character — ASCII letters
// uppercased, Han ideographs and digits kept as-is. Any other character
// (including emoji and punctuation) and an empty nickname fall back to the
// person icon; the email is never used as a substitute.
export function avatarInitial(name: string | null | undefined): string | null {
  // Array.from iterates code points, so a surrogate-pair character (emoji,
  // rare CJK extension) is judged as one character, not a half surrogate.
  const first = Array.from((name ?? "").trim())[0];
  if (!first) return null;
  if (/[a-zA-Z]/.test(first)) return first.toUpperCase();
  if (/\p{Script=Han}/u.test(first) || /[0-9]/.test(first)) return first;
  return null;
}

export default function UserAvatar({ user }: { user: CurrentUser | null }) {
  if (!user) return null;
  const initial = avatarInitial(user.name);
  return (
    <Avatar className="h-9 w-9">
      <AvatarFallback className="bg-muted text-muted-foreground">
        {initial ? (
          <span aria-hidden="true" className="text-sm font-medium">
            {initial}
          </span>
        ) : (
          <User className="h-5 w-5" />
        )}
      </AvatarFallback>
    </Avatar>
  );
}

import { APP_CONSTANTS } from "@/lib/constants";
import {
  getFromLocalStorage,
  saveToLocalStorage,
} from "@/utils/localstorage.utils";

const KEY = APP_CONSTANTS.AGENT_CHAT_ACTIVE_CONVERSATION_KEY;
const MAX_AGE = 60 * 60 * 24 * 365;

export function readActiveConversationId(): string | null {
  const stored = getFromLocalStorage(KEY, null);
  return typeof stored === "string" && stored.length > 0 ? stored : null;
}

/** Opaque id only. Transcripts stay on the server. */
export function writeActiveConversationId(id: string | null): void {
  if (typeof document === "undefined") return;
  if (id) {
    saveToLocalStorage(KEY, id);
    document.cookie = `${KEY}=${encodeURIComponent(id)}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax`;
    return;
  }
  saveToLocalStorage(KEY, "");
  // Distinguish an intentional draft from a legacy client with no cookie.
  document.cookie = `${KEY}=${APP_CONSTANTS.AGENT_CHAT_DRAFT_CONVERSATION_ID}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax`;
}

// SET-INPUT-PREFERENCES: device-local storage contract — defaults for empty
// or corrupt snapshots, per-key fallback on invalid values, merged partial
// updates, same-tab change notification and restart persistence.
import { act, renderHook } from "@testing-library/react";
import { vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/actions/userSettings.actions", () => ({
  getUserSettings: vi.fn(async () => ({ success: true, data: null })),
}));

import { APP_CONSTANTS } from "@/lib/constants";
import {
  DEFAULT_INPUT_PREFERENCES,
  INPUT_PREFERENCES_CHANGED_EVENT,
  readInputPreferences,
  updateInputPreferences,
  useInputPreferences,
} from "@/lib/inputPreferences";

const KEY = APP_CONSTANTS.INPUT_PREFERENCES_STORAGE_KEY;

function storedSnapshot() {
  const raw = localStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
}

describe("input preferences storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns the four defaults when nothing is stored", () => {
    expect(readInputPreferences()).toEqual({
      enterBehavior: "newline",
      editEntry: "click",
      hintMode: "focus",
      autoFocus: false,
    });
  });

  it("falls back to defaults on a corrupt snapshot", () => {
    localStorage.setItem(KEY, "{not json");
    expect(readInputPreferences()).toEqual(DEFAULT_INPUT_PREFERENCES);
  });

  it("falls back per key on invalid values and keeps valid ones", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        enterBehavior: "submit",
        editEntry: "select-all",
        hintMode: 7,
        autoFocus: "yes",
      }),
    );
    expect(readInputPreferences()).toEqual({
      enterBehavior: "newline",
      editEntry: "select-all",
      hintMode: "focus",
      autoFocus: false,
    });
  });

  it("keeps other settings untouched by a partial update", () => {
    updateInputPreferences({ enterBehavior: "next" });
    updateInputPreferences({ hintMode: "off" });
    expect(readInputPreferences()).toEqual({
      enterBehavior: "next",
      editEntry: "click",
      hintMode: "off",
      autoFocus: false,
    });
  });

  it("persists the snapshot so a later session reads the same values", () => {
    updateInputPreferences({ autoFocus: true, editEntry: "end" });
    expect(storedSnapshot()).toEqual({
      enterBehavior: "newline",
      editEntry: "end",
      hintMode: "focus",
      autoFocus: true,
    });
    expect(readInputPreferences().autoFocus).toBe(true);
  });

  it("notifies mounted readers so changes take effect without remount", () => {
    const { result } = renderHook(() => useInputPreferences());
    expect(result.current.enterBehavior).toBe("newline");
    act(() => {
      updateInputPreferences({ enterBehavior: "next" });
    });
    expect(result.current.enterBehavior).toBe("next");
  });

  it("dispatches the change event once per update", () => {
    const listener = vi.fn();
    window.addEventListener(INPUT_PREFERENCES_CHANGED_EVENT, listener);
    try {
      updateInputPreferences({ hintMode: "always" });
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(INPUT_PREFERENCES_CHANGED_EVENT, listener);
    }
  });
});

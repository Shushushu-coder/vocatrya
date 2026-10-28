"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/i18n";
import type { Locale } from "@/i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { isDesktopShell } from "../desktop/desktopShell";
import { toastError } from "@/lib/toast";
import {
  comboFromEvent,
  comboToDisplayKeys,
  isModifierKey,
} from "@/lib/shortcuts/combos";
import {
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
  type WindowShortcutActionId,
} from "@/lib/shortcuts/registry";
import {
  findComboConflict,
  useShortcutSnapshot,
  writeGlobalToggle,
  writeWindowBinding,
} from "@/lib/shortcuts/bindings";

// INT-01 owns the shared message bundles; until the declared keys land,
// t() echoes the key and the paired fallback keeps the page readable.
function useCopy() {
  const { t, locale } = useI18n();
  return (key: string, fallback: Record<Locale, string>) => {
    const translated = t(key);
    return translated === key ? fallback[locale] : translated;
  };
}

function KeyCombo({
  keys,
  joiner = "+",
}: {
  keys: string[];
  // "+" renders a chord (Alt+←), "/" renders alternatives (← / →).
  joiner?: "+" | "/";
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((key, index) => (
        <span key={key} className="flex items-center gap-1">
          {index > 0 && (
            <span className="text-xs text-muted-foreground">{joiner}</span>
          )}
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-[11px] font-medium">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}

function ShortcutRow({
  name,
  description,
  keys,
  joiner,
  note,
  aside,
  testId,
}: {
  name: string;
  description: string;
  keys?: string[];
  joiner?: "+" | "/";
  note?: ReactNode;
  aside?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3"
      data-testid={testId}
    >
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-sm font-medium leading-none break-words">
          {name}
        </div>
        <p className="mt-1 text-sm text-muted-foreground break-words">
          {description}
        </p>
        {note}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {keys && <KeyCombo keys={keys} joiner={joiner} />}
        {aside}
      </div>
    </div>
  );
}

function ShortcutGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h4 className="text-sm font-medium break-words">{title}</h4>
      <div className="divide-y">{children}</div>
    </section>
  );
}

type RowErrors = Partial<Record<ShortcutActionId, string>>;

// The rebindable actions: the three window-scope bindings plus the global
// show/hide hotkey. Recording a new combo uses a capture-phase window
// listener so the pressed keys never reach the app's own shortcuts — and
// conflict detection runs against every other live binding before write.
function ShortcutsSettings() {
  const copy = useCopy();
  const snapshot = useShortcutSnapshot();
  const [desktopShell, setDesktopShell] = useState<boolean | null>(null);
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [rowErrors, setRowErrors] = useState<RowErrors>({});
  const [saving, setSaving] = useState(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    setDesktopShell(isDesktopShell());
  }, []);

  const setRowError = useCallback(
    (action: ShortcutActionId, message: string | null) => {
      setRowErrors((prev) => ({ ...prev, [action]: message ?? undefined }));
    },
    [],
  );

  const copyRef = useRef(copy);
  copyRef.current = copy;

  const saveCombo = useCallback(
    async (action: ShortcutActionId, combo: string | null) => {
      setSaving(true);
      try {
        const result =
          action === "toggleWindow"
            ? await writeGlobalToggle(combo ? { combo } : {})
            : await writeWindowBinding(action, combo);
        if (result.ok) {
          setRowError(action, null);
          const occupied = result.state.global.error;
          if (action === "toggleWindow" && occupied === "occupied") {
            setRowError(
              action,
              copyRef.current("settings.shortcutsGlobalOccupied", {
                "zh-CN": "该组合键被系统或其他应用占用，未能注册。",
                en: "This combination is taken by the OS or another app; registration failed.",
              }),
            );
          }
          return;
        }
        if (result.code === "conflict") {
          setRowError(
            action,
            copyRef.current("settings.shortcutsConflict", {
              "zh-CN": "该组合键已被其他快捷键使用。",
              en: "This combination is already used by another shortcut.",
            }),
          );
        } else if (result.code === "occupied") {
          setRowError(
            action,
            copyRef.current("settings.shortcutsGlobalOccupied", {
              "zh-CN": "该组合键被系统或其他应用占用，未能注册。",
              en: "This combination is taken by the OS or another app; registration failed.",
            }),
          );
        } else {
          setRowError(
            action,
            copyRef.current("settings.shortcutsSaveFailed", {
              "zh-CN": "快捷键设置保存失败。",
              en: "Failed to save the shortcut.",
            }),
          );
        }
      } catch (error) {
        console.error("Error saving shortcut binding:", error);
        setRowError(
          action,
          copyRef.current("settings.shortcutsSaveFailed", {
            "zh-CN": "快捷键设置保存失败。",
            en: "Failed to save the shortcut.",
          }),
        );
        toastError(
          copyRef.current("settings.shortcutsSaveFailed", {
            "zh-CN": "快捷键设置保存失败。",
            en: "Failed to save the shortcut.",
          }),
        );
      } finally {
        setSaving(false);
      }
    },
    [setRowError],
  );

  // Capture-phase keydown while recording: stopImmediatePropagation keeps
  // the candidate combo away from the app's own window shortcuts. Esc
  // cancels; a bare modifier press means the user is still composing; an
  // unbindable key or a conflict reports the reason inline.
  useEffect(() => {
    if (!recording) return;
    const action = recording;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      if (isModifierKey(event.key)) return;
      const combo = comboFromEvent(event);
      if (!combo) {
        setRowError(
          action,
          copyRef.current("settings.shortcutsInvalidCombo", {
            "zh-CN": "组合键需包含 Ctrl 或 Alt，并以字母、数字、功能键或常用按键结尾。",
            en: "A shortcut needs Ctrl or Alt plus a letter, digit, function key, or named key.",
          }),
        );
        setRecording(null);
        return;
      }
      const conflict = findComboConflict(snapshotRef.current, action, combo);
      if (conflict) {
        setRowError(
          action,
          copyRef.current("settings.shortcutsConflict", {
            "zh-CN": "该组合键已被其他快捷键使用。",
            en: "This combination is already used by another shortcut.",
          }),
        );
        setRecording(null);
        return;
      }
      setRecording(null);
      void saveCombo(action, combo);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, saveCombo, setRowError]);

  const editable = snapshot.loaded && snapshot.bridgeAvailable;
  const loading = !snapshot.loaded;

  const desktopOnlyBadge = (
    <Badge variant="outline">
      {copy("settings.capabilityDesktopOnly", {
        "zh-CN": "仅桌面应用",
        en: "Desktop app only",
      })}
    </Badge>
  );

  // In a browser there is no device store: the rows honestly show the
  // compiled-in defaults and the edit affordance is the desktop-only badge —
  // never a fake save path.
  function editControls(action: ShortcutActionId) {
    if (!editable) {
      return loading ? null : desktopOnlyBadge;
    }
    const actionMeta = SHORTCUT_ACTIONS[action];
    const current =
      action === "toggleWindow"
        ? snapshot.global.combo
        : snapshot.window[action];
    const isDefault = current === actionMeta.defaultCombo;
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={saving || recording !== null}
          onClick={() => {
            setRowError(action, null);
            setRecording(action);
          }}
          data-testid={`shortcut-rebind-${action}`}
        >
          {copy("settings.shortcutsRebind", {
            "zh-CN": "修改",
            en: "Change",
          })}
        </Button>
        {action !== "toggleWindow" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving || recording !== null || current === null}
            onClick={() => void saveCombo(action, null)}
            data-testid={`shortcut-clear-${action}`}
          >
            {copy("settings.shortcutsClear", {
              "zh-CN": "清除",
              en: "Clear",
            })}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={saving || recording !== null || isDefault}
          onClick={() => void saveCombo(action, actionMeta.defaultCombo)}
          data-testid={`shortcut-reset-${action}`}
        >
          {copy("settings.shortcutsReset", {
            "zh-CN": "恢复默认",
            en: "Reset",
          })}
        </Button>
      </>
    );
  }

  function rowNote(action: ShortcutActionId, extra?: ReactNode) {
    const error = rowErrors[action];
    if (!error && !extra) return undefined;
    return (
      <>
        {error && (
          <p
            className="mt-1 text-sm text-destructive break-words"
            data-testid={`shortcut-error-${action}`}
          >
            {error}
          </p>
        )}
        {extra}
      </>
    );
  }

  const windowRows: {
    action: WindowShortcutActionId;
    name: string;
    description: string;
    scopeNote?: ReactNode;
  }[] = [
    {
      action: "toggleSidebar",
      name: copy("shortcuts.toggleSidebar", {
        "zh-CN": "展开或收起侧边栏",
        en: "Expand or collapse the sidebar",
      }),
      description: copy("settings.shortcutsSidebarToggleScope", {
        "zh-CN":
          "应用窗口内生效；焦点位于文本输入控件时不触发（macOS 为 ⌘B）。",
        en: "Active inside the app window; suppressed while a text input is focused (⌘B on macOS).",
      }),
    },
    {
      action: "historyBack",
      name: copy("shortcuts.goBack", {
        "zh-CN": "后退一页",
        en: "Go back one page",
      }),
      description: copy("settings.shortcutsHistoryScope", {
        "zh-CN": "仅桌面应用窗口内生效；浏览器环境中不可用。",
        en: "Active only inside the desktop app window; not available in a browser.",
      }),
      scopeNote: desktopOnlyBadge,
    },
    {
      action: "historyForward",
      name: copy("shortcuts.goForward", {
        "zh-CN": "前进一页",
        en: "Go forward one page",
      }),
      description: copy("settings.shortcutsHistoryScope", {
        "zh-CN": "仅桌面应用窗口内生效；浏览器环境中不可用。",
        en: "Active only inside the desktop app window; not available in a browser.",
      }),
      scopeNote: desktopOnlyBadge,
    },
  ];

  const globalState = snapshot.global;
  const globalStatus = !globalState.enabled
    ? copy("settings.shortcutsGlobalOff", {
        "zh-CN": "未启用",
        en: "Off",
      })
    : globalState.registered
      ? copy("settings.shortcutsGlobalOn", {
          "zh-CN": "已生效",
          en: "Registered",
        })
      : globalState.error === "occupied"
        ? copy("settings.shortcutsGlobalOccupied", {
            "zh-CN": "该组合键被系统或其他应用占用，未能注册。",
            en: "This combination is taken by the OS or another app; registration failed.",
          })
        : copy("settings.shortcutsGlobalUnregistered", {
            "zh-CN": "未注册",
            en: "Not registered",
          });

  return (
    <div className="space-y-4" data-testid="shortcuts-settings">
      <div>
        <h3 className="text-lg font-medium">
          {copy("settings.shortcuts", {
            "zh-CN": "快捷键",
            en: "Shortcuts",
          })}
        </h3>
        <p className="text-sm text-muted-foreground break-words">
          {copy("settings.shortcutsDescriptionV2", {
            "zh-CN":
              "应用窗口快捷键可在桌面应用内重绑定；系统级全局热键默认关闭。控件内按键为只读声明。",
            en: "App-window shortcuts can be rebound inside the desktop app; the OS-level global hotkey is off by default. Control-level keys are read-only.",
          })}
        </p>
      </div>

      {desktopShell === false && (
        <p
          className="text-sm text-muted-foreground break-words"
          data-testid="shortcuts-env-note"
        >
          {copy("settings.shortcutsEnvironmentNote", {
            "zh-CN":
              "当前环境不是桌面应用：标记为“仅桌面应用”的快捷键在此环境中不生效。",
            en: "This environment is not the desktop app: shortcuts marked “Desktop app only” do not fire here.",
          })}
        </p>
      )}

      <ShortcutGroup
        title={copy("settings.shortcutsWindowGroup", {
          "zh-CN": "应用窗口",
          en: "App window",
        })}
      >
        {windowRows.map((row) => (
          <ShortcutRow
            key={row.action}
            testId={`shortcut-row-${row.action}`}
            name={row.name}
            description={row.description}
            keys={
              recording === row.action
                ? undefined
                : snapshot.window[row.action]
                  ? comboToDisplayKeys(snapshot.window[row.action])
                  : undefined
            }
            note={rowNote(row.action)}
            aside={
              <>
                {recording === row.action && (
                  <span className="text-xs text-muted-foreground">
                    {copy("settings.shortcutsRecording", {
                      "zh-CN": "按下新的组合键，Esc 取消。",
                      en: "Press the new combination — Esc cancels.",
                    })}
                  </span>
                )}
                {recording !== row.action &&
                  snapshot.window[row.action] === null && (
                    <span className="text-xs text-muted-foreground">
                      {copy("settings.shortcutsUnbound", {
                        "zh-CN": "未绑定",
                        en: "Not bound",
                      })}
                    </span>
                  )}
                {editable && row.scopeNote}
                {editControls(row.action)}
              </>
            }
          />
        ))}
      </ShortcutGroup>

      <ShortcutGroup
        title={copy("settings.shortcutsGlobalGroup", {
          "zh-CN": "系统级全局快捷键",
          en: "OS-level global shortcut",
        })}
      >
        <ShortcutRow
          testId="shortcut-row-toggleWindow"
          name={copy("settings.shortcutsToggleWindow", {
            "zh-CN": "显示或隐藏主窗口",
            en: "Show or hide the main window",
          })}
          description={copy("settings.shortcutsToggleWindowScope", {
            "zh-CN":
              "窗口隐藏或最小化时按组合键唤出并聚焦；窗口可见且聚焦时将其隐藏。应用未运行时不生效。",
            en: "Hidden or minimized windows are restored and focused; a visible, focused window hides. Inactive while the app is not running.",
          })}
          keys={
            recording === "toggleWindow"
              ? undefined
              : comboToDisplayKeys(globalState.combo)
          }
          note={rowNote(
            "toggleWindow",
            <p
              className="mt-1 text-sm text-muted-foreground break-words"
              data-testid="shortcut-global-status"
            >
              {globalStatus}
            </p>,
          )}
          aside={
            <>
              {editable && (
                <Switch
                  checked={globalState.enabled}
                  disabled={saving || recording !== null}
                  onCheckedChange={(enabled) => {
                    setRowError("toggleWindow", null);
                    setSaving(true);
                    void writeGlobalToggle({ enabled })
                      .then((result) => {
                        if (!result.ok) {
                          setRowError(
                            "toggleWindow",
                            result.code === "conflict"
                              ? copyRef.current("settings.shortcutsConflict", {
                                  "zh-CN": "该组合键已被其他快捷键使用。",
                                  en: "This combination is already used by another shortcut.",
                                })
                              : copyRef.current("settings.shortcutsSaveFailed", {
                                  "zh-CN": "快捷键设置保存失败。",
                                  en: "Failed to save the shortcut.",
                                }),
                          );
                          return;
                        }
                        const status = result.state.global;
                        if (status.enabled && !status.registered) {
                          setRowError(
                            "toggleWindow",
                            copyRef.current("settings.shortcutsGlobalOccupied", {
                              "zh-CN":
                                "该组合键被系统或其他应用占用，未能注册。",
                              en: "This combination is taken by the OS or another app; registration failed.",
                            }),
                          );
                        }
                      })
                      .catch((error) => {
                        console.error("Error toggling global shortcut:", error);
                        toastError(
                          copyRef.current("settings.shortcutsSaveFailed", {
                            "zh-CN": "快捷键设置保存失败。",
                            en: "Failed to save the shortcut.",
                          }),
                        );
                      })
                      .finally(() => setSaving(false));
                  }}
                  aria-label={copy("settings.shortcutsToggleWindow", {
                    "zh-CN": "显示或隐藏主窗口",
                    en: "Show or hide the main window",
                  })}
                  data-testid="shortcut-global-toggle"
                />
              )}
              {recording === "toggleWindow" && (
                <span className="text-xs text-muted-foreground">
                  {copy("settings.shortcutsRecording", {
                    "zh-CN": "按下新的组合键，Esc 取消。",
                    en: "Press the new combination — Esc cancels.",
                  })}
                </span>
              )}
              {editControls("toggleWindow")}
            </>
          }
        />
      </ShortcutGroup>

      <ShortcutGroup
        title={copy("settings.shortcutsControlGroup", {
          "zh-CN": "控件内按键",
          en: "Control-level keys",
        })}
      >
        <ShortcutRow
          name={copy("settings.shortcutsSidebarResize", {
            "zh-CN": "调整侧边栏宽度",
            en: "Resize the sidebar",
          })}
          description={copy("settings.shortcutsSidebarResizeScope", {
            "zh-CN": "焦点位于侧边栏宽度调节手柄时生效。",
            en: "Active while the sidebar resize handle is focused.",
          })}
          keys={["←", "→"]}
          joiner="/"
        />
        <ShortcutRow
          name={copy("shortcuts.toggleSidebar", {
            "zh-CN": "展开或收起侧边栏",
            en: "Expand or collapse the sidebar",
          })}
          description={copy("settings.shortcutsSidebarResizeScope", {
            "zh-CN": "焦点位于侧边栏宽度调节手柄时生效。",
            en: "Active while the sidebar resize handle is focused.",
          })}
          keys={["Enter"]}
        />
        <ShortcutRow
          name={copy("settings.shortcutsPromptSubmit", {
            "zh-CN": "发送输入内容",
            en: "Submit the message",
          })}
          description={copy("settings.shortcutsPromptSubmitScope", {
            "zh-CN": "AI 输入框聚焦时生效；Shift+Enter 插入换行。",
            en: "Active while the AI input is focused; Shift+Enter inserts a newline.",
          })}
          keys={["Enter"]}
        />
        <ShortcutRow
          name={copy("settings.shortcutsPromptBackspace", {
            "zh-CN": "移除最后一个附件",
            en: "Remove the last attachment",
          })}
          description={copy("settings.shortcutsPromptBackspaceScope", {
            "zh-CN": "AI 输入框为空且存在附件时生效。",
            en: "Active while the AI input is empty and attachments exist.",
          })}
          keys={["Backspace"]}
        />
        <ShortcutRow
          name={copy("settings.shortcutsEnterConfirm", {
            "zh-CN": "提交当前输入",
            en: "Confirm the current input",
          })}
          description={copy("settings.shortcutsEnterConfirmScope", {
            "zh-CN":
              "聚焦的单行输入框或可创建选项的下拉框内生效（如添加职位链接、创建下拉新选项）。",
            en: "Active inside focused single-line inputs and creatable dropdowns (e.g. adding a job URL or creating a new option).",
          })}
          keys={["Enter"]}
        />
      </ShortcutGroup>

      <ShortcutGroup
        title={copy("settings.shortcutsNativeGroup", {
          "zh-CN": "系统与弹层按键",
          en: "System & overlay keys",
        })}
      >
        <ShortcutRow
          name={copy("settings.shortcutsTextEditing", {
            "zh-CN": "文本编辑",
            en: "Text editing",
          })}
          description={copy("settings.shortcutsTextEditingScope", {
            "zh-CN":
              "复制 / 粘贴 / 剪切 / 全选 / 撤销 / 重做，由系统编辑控件原生提供，焦点位于文本输入控件时生效。",
            en: "Copy / paste / cut / select all / undo / redo, provided natively by the OS editing controls while a text input is focused.",
          })}
          keys={["Ctrl", "C/V/X/A/Z/Y"]}
        />
        <ShortcutRow
          name={copy("settings.shortcutsEscape", {
            "zh-CN": "关闭对话框或弹出面板",
            en: "Close dialogs and popovers",
          })}
          description={copy("settings.shortcutsEscapeScope", {
            "zh-CN":
              "打开的弹层组件内生效；计时中的休息弹窗等个别场景除外。",
            en: "Active inside open overlay components; a few surfaces such as an in-progress break dialog are exempt.",
          })}
          keys={["Esc"]}
        />
      </ShortcutGroup>
    </div>
  );
}

export default ShortcutsSettings;

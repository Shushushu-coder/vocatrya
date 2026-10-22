"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/i18n";
import type { Locale } from "@/i18n";
import { Badge } from "../ui/badge";
import { isDesktopShell } from "../desktop/desktopShell";

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
  aside,
}: {
  name: string;
  description: string;
  keys?: string[];
  joiner?: "+" | "/";
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-sm font-medium leading-none break-words">
          {name}
        </div>
        <p className="mt-1 text-sm text-muted-foreground break-words">
          {description}
        </p>
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

// Audited at baseline 59499771: the app registers no OS-level global
// shortcuts (no globalShortcut anywhere, application menu is removed) and
// has no keybinding store. What exists is one window-level listener
// (Ctrl/Cmd+B), two desktop-shell history listeners (Alt+Left/Right), and
// element-scoped key handling inside specific controls. Everything below
// is labelled with its real scope; nothing here is rebindable.
function ShortcutsSettings() {
  const copy = useCopy();
  // Alt+Left/Right only fire inside the Electron shell; the environment
  // flag is read after mount so SSR output stays identical.
  const [desktopShell, setDesktopShell] = useState<boolean | null>(null);
  useEffect(() => {
    setDesktopShell(isDesktopShell());
  }, []);

  const badge = (key: string, fallback: Record<Locale, string>) => (
    <Badge variant="outline">{copy(key, fallback)}</Badge>
  );

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
          {copy("settings.shortcutsDescription", {
            "zh-CN":
              "以下按键在当前版本实际生效，作用域均为应用窗口或控件级；没有系统级全局快捷键，也不支持自定义重绑定。",
            en: "The keys below are active in this version, all scoped to the app window or focused controls. There are no OS-level global shortcuts and no custom rebinding.",
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
        <ShortcutRow
          name={copy("shortcuts.toggleSidebar", {
            "zh-CN": "展开或收起侧边栏",
            en: "Expand or collapse the sidebar",
          })}
          description={copy("settings.shortcutsSidebarToggleScope", {
            "zh-CN":
              "应用窗口内生效；焦点位于文本输入控件时不触发（macOS 为 ⌘B）。",
            en: "Active inside the app window; suppressed while a text input is focused (⌘B on macOS).",
          })}
          keys={["Ctrl", "B"]}
        />
        <ShortcutRow
          name={copy("shortcuts.goBack", {
            "zh-CN": "后退一页",
            en: "Go back one page",
          })}
          description={copy("settings.shortcutsHistoryScope", {
            "zh-CN": "仅桌面应用窗口内生效；浏览器环境中不可用。",
            en: "Active only inside the desktop app window; not available in a browser.",
          })}
          keys={["Alt", "←"]}
          aside={badge("settings.capabilityDesktopOnly", {
            "zh-CN": "仅桌面应用",
            en: "Desktop app only",
          })}
        />
        <ShortcutRow
          name={copy("shortcuts.goForward", {
            "zh-CN": "前进一页",
            en: "Go forward one page",
          })}
          description={copy("settings.shortcutsHistoryScope", {
            "zh-CN": "仅桌面应用窗口内生效；浏览器环境中不可用。",
            en: "Active only inside the desktop app window; not available in a browser.",
          })}
          keys={["Alt", "→"]}
          aside={badge("settings.capabilityDesktopOnly", {
            "zh-CN": "仅桌面应用",
            en: "Desktop app only",
          })}
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

      <ShortcutGroup
        title={copy("settings.shortcutsUnavailableGroup", {
          "zh-CN": "未提供的能力",
          en: "Unavailable capabilities",
        })}
      >
        <ShortcutRow
          name={copy("settings.shortcutsGlobalTitle", {
            "zh-CN": "系统级全局快捷键",
            en: "OS-level global shortcuts",
          })}
          description={copy("settings.shortcutsGlobalDescription", {
            "zh-CN": "应用未注册任何系统级全局快捷键。",
            en: "The app registers no OS-level global shortcuts.",
          })}
          aside={badge("settings.capabilityNotProvided", {
            "zh-CN": "未提供",
            en: "Not provided",
          })}
        />
        <ShortcutRow
          name={copy("settings.shortcutsRebindTitle", {
            "zh-CN": "自定义快捷键",
            en: "Custom keybindings",
          })}
          description={copy("settings.shortcutsRebindDescription", {
            "zh-CN": "当前版本不支持修改或重绑定快捷键，没有对应的配置存储。",
            en: "Shortcuts cannot be edited or rebound in this version; no keybinding store exists.",
          })}
          aside={badge("settings.capabilityNotProvided", {
            "zh-CN": "未提供",
            en: "Not provided",
          })}
        />
      </ShortcutGroup>
    </div>
  );
}

export default ShortcutsSettings;

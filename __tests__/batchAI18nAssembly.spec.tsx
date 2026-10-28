// INT-01 Batch A i18n assembly contract: every key declared by the frozen
// BATCH_A_I18N_UNION must resolve through the real translate()/hasTranslation
// path in BOTH locale bundles — component-level F fallbacks are not accepted
// as proof of bundle assembly (see SET-08_I18N_HANDOFF §5).
import { render, screen } from "@testing-library/react";
import { I18nProvider, hasTranslation, translate } from "@/i18n";
import NotificationsSettings from "@/components/settings/NotificationsSettings";
import ShortcutsSettings from "@/components/settings/ShortcutsSettings";
import AudioSettings from "@/components/settings/AudioSettings";
import type { Locale } from "@/i18n";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const LOCALES: readonly Locale[] = ["en", "zh-CN"];
const idx = (locale: Locale) => (locale === "en" ? 0 : 1);

// key → [en, zh-CN] expected bundle values (frozen authoritative copy)
const NEW_KEYS: Record<string, [string, string]> = {
  "settings.groups.preferences": [
    "Preferences",
    "偏好设置"
  ],
  "settings.groups.devices": [
    "Devices & Input",
    "设备与输入"
  ],
  "settings.groups.dataSupport": [
    "Data & Support",
    "数据与支持"
  ],
  "settings.sections.notifications": [
    "Notifications",
    "通知"
  ],
  "settings.sections.aiServices": [
    "AI Services",
    "AI 服务"
  ],
  "settings.sections.aiAssignments": [
    "AI Assignments",
    "AI 业务分配"
  ],
  "settings.sections.shortcuts": [
    "Shortcuts",
    "快捷键"
  ],
  "settings.sections.audio": [
    "Audio",
    "音频"
  ],
  "settings.sections.dataPrivacy": [
    "Data & Privacy",
    "数据与隐私"
  ],
  "settings.sections.about": [
    "About",
    "关于"
  ],
  "settings.sectionUnavailable": [
    "This settings page is not available in this build yet.",
    "该设置页在当前版本中尚未提供。"
  ],
  "settings.drawer.discardTitle": [
    "Discard unsaved changes?",
    "丢弃未保存的更改？"
  ],
  "settings.drawer.discardDescription": [
    "This panel has unsaved changes. Closing it will discard them.",
    "此面板存在未保存的更改，关闭将丢弃这些更改。"
  ],
  "settings.drawer.keepEditing": [
    "Keep editing",
    "继续编辑"
  ],
  "settings.drawer.discardAction": [
    "Discard changes",
    "丢弃更改"
  ],
  "settings.notifications": [
    "Notifications",
    "通知"
  ],
  "settings.notificationsDescription": [
    "Schedule reminders arrive as Windows system notifications; in-app feedback messages are built in.",
    "日程提醒以 Windows 系统通知送达；应用内消息反馈为内置机制。"
  ],
  "settings.notificationsInAppTitle": [
    "In-app feedback messages",
    "应用内消息反馈"
  ],
  "settings.notificationsInAppDescription": [
    "Action results and error messages appear as in-app toast messages. This is a built-in feedback mechanism, not a configurable option.",
    "操作结果与错误提示以应用内浮动消息（toast）即时显示。这是内置反馈机制，不属于可配置项。"
  ],
  "settings.capabilityBuiltIn": [
    "Built-in",
    "内置"
  ],
  "settings.notificationsSystemTitle": [
    "System notifications",
    "系统通知"
  ],
  "settings.notificationsSystemDescription": [
    "Process-step schedules and job deadlines raise a Windows system notification when due. Delivered while the app is running (including minimized or hidden to tray); not delivered after a full quit.",
    "流程步骤排期与岗位截止在到期时通过 Windows 系统通知提醒。应用运行（含最小化或托盘隐藏）时送达；完全退出后不再送达。"
  ],
  "settings.capabilityNotProvided": [
    "Not provided",
    "未提供"
  ],
  "settings.notificationsPreferencesTitle": [
    "Notification preferences",
    "通知偏好"
  ],
  "settings.notificationsPreferencesDescription": [
    "Choose how far ahead of the scheduled time reminders fire.",
    "选择提醒相对日程时间的提前量。"
  ],
  "settings.notificationsFootnote": [
    "Reminders are delivered while the app is running (including minimized or hidden to tray). Delivery is not guaranteed after a full quit; on reopen, reminders overdue by less than 24 hours fire immediately. Action results and critical error feedback always stay visible in the current task view.",
    "提醒在应用运行（含最小化或托盘隐藏）时送达；完全退出应用后不承诺送达，重新打开时 24 小时内的逾期提醒会立即补送。操作结果与关键错误反馈始终显示在当前任务界面。"
  ],
  "settings.shortcuts": [
    "Shortcuts",
    "快捷键"
  ],
  "settings.shortcutsDescription": [
    "The keys below are active in this version, all scoped to the app window or focused controls. There are no OS-level global shortcuts and no custom rebinding.",
    "以下按键在当前版本实际生效，作用域均为应用窗口或控件级；没有系统级全局快捷键，也不支持自定义重绑定。"
  ],
  "settings.shortcutsEnvironmentNote": [
    "This environment is not the desktop app: shortcuts marked “Desktop app only” do not fire here.",
    "当前环境不是桌面应用：标记为“仅桌面应用”的快捷键在此环境中不生效。"
  ],
  "settings.shortcutsWindowGroup": [
    "App window",
    "应用窗口"
  ],
  "settings.shortcutsSidebarToggleScope": [
    "Active inside the app window; suppressed while a text input is focused (⌘B on macOS).",
    "应用窗口内生效；焦点位于文本输入控件时不触发（macOS 为 ⌘B）。"
  ],
  "settings.shortcutsHistoryScope": [
    "Active only inside the desktop app window; not available in a browser.",
    "仅桌面应用窗口内生效；浏览器环境中不可用。"
  ],
  "settings.capabilityDesktopOnly": [
    "Desktop app only",
    "仅桌面应用"
  ],
  "settings.shortcutsControlGroup": [
    "Control-level keys",
    "控件内按键"
  ],
  "settings.shortcutsSidebarResize": [
    "Resize the sidebar",
    "调整侧边栏宽度"
  ],
  "settings.shortcutsSidebarResizeScope": [
    "Active while the sidebar resize handle is focused.",
    "焦点位于侧边栏宽度调节手柄时生效。"
  ],
  "settings.shortcutsPromptSubmit": [
    "Submit the message",
    "发送输入内容"
  ],
  "settings.shortcutsPromptSubmitScope": [
    "Active while the AI input is focused; Shift+Enter inserts a newline.",
    "AI 输入框聚焦时生效；Shift+Enter 插入换行。"
  ],
  "settings.shortcutsPromptBackspace": [
    "Remove the last attachment",
    "移除最后一个附件"
  ],
  "settings.shortcutsPromptBackspaceScope": [
    "Active while the AI input is empty and attachments exist.",
    "AI 输入框为空且存在附件时生效。"
  ],
  "settings.shortcutsEnterConfirm": [
    "Confirm the current input",
    "提交当前输入"
  ],
  "settings.shortcutsEnterConfirmScope": [
    "Active inside focused single-line inputs and creatable dropdowns (e.g. adding a job URL or creating a new option).",
    "聚焦的单行输入框或可创建选项的下拉框内生效（如添加职位链接、创建下拉新选项）。"
  ],
  "settings.shortcutsNativeGroup": [
    "System & overlay keys",
    "系统与弹层按键"
  ],
  "settings.shortcutsTextEditing": [
    "Text editing",
    "文本编辑"
  ],
  "settings.shortcutsTextEditingScope": [
    "Copy / paste / cut / select all / undo / redo, provided natively by the OS editing controls while a text input is focused.",
    "复制 / 粘贴 / 剪切 / 全选 / 撤销 / 重做，由系统编辑控件原生提供，焦点位于文本输入控件时生效。"
  ],
  "settings.shortcutsEscape": [
    "Close dialogs and popovers",
    "关闭对话框或弹出面板"
  ],
  "settings.shortcutsEscapeScope": [
    "Active inside open overlay components; a few surfaces such as an in-progress break dialog are exempt.",
    "打开的弹层组件内生效；计时中的休息弹窗等个别场景除外。"
  ],
  "settings.shortcutsUnavailableGroup": [
    "Unavailable capabilities",
    "未提供的能力"
  ],
  "settings.shortcutsGlobalTitle": [
    "OS-level global shortcuts",
    "系统级全局快捷键"
  ],
  "settings.shortcutsGlobalDescription": [
    "The app registers no OS-level global shortcuts.",
    "应用未注册任何系统级全局快捷键。"
  ],
  "settings.shortcutsRebindTitle": [
    "Custom keybindings",
    "自定义快捷键"
  ],
  "settings.shortcutsRebindDescription": [
    "Shortcuts cannot be edited or rebound in this version; no keybinding store exists.",
    "当前版本不支持修改或重绑定快捷键，没有对应的配置存储。"
  ],
  "settings.audio": [
    "Audio",
    "音频"
  ],
  "settings.audioDescription": [
    "This version integrates no audio input, output, or device-management capability, so no audio settings are offered here.",
    "当前版本未集成音频输入、输出或设备管理能力，本页不提供任何可保存的音频设置。"
  ],
  "settings.audioMicrophoneTitle": [
    "Microphone input",
    "麦克风输入"
  ],
  "settings.audioMicrophoneDescription": [
    "The app does not capture audio and never requests microphone permission.",
    "应用不采集音频，也不会请求麦克风权限。"
  ],
  "settings.audioOutputTitle": [
    "Audio output & device switching",
    "音频输出与设备切换"
  ],
  "settings.audioOutputDescription": [
    "There is no audio playback or audio device selection capability.",
    "没有音频播放或音频设备选择能力。"
  ],
  "settings.audioTranscriptionTitle": [
    "Speech transcription & recognition",
    "语音转写与识别"
  ],
  "settings.audioTranscriptionDescription": [
    "No speech-to-text capability exists.",
    "没有语音转文字能力。"
  ],
  "settings.audioRecordingTitle": [
    "Recording test",
    "录音测试"
  ],
  "settings.audioRecordingDescription": [
    "There is no recording feature to test.",
    "没有录音功能可供测试。"
  ],
  "settings.audioFootnote": [
    "The only media call in the app is screen capture in the AI input (explicitly without audio). Once real audio capability is integrated, this page will list the actual settings and states.",
    "应用内唯一的媒体调用是 AI 输入框的屏幕截图（明确不含音轨）。接入真实音频能力后，本页将展示实际设置项与状态。"
  ]
};

const REUSED_KEYS: Record<string, [string, string]> = {
  "settings.title": [
    "Settings",
    "系统设置"
  ],
  "settings.general": [
    "General",
    "常规偏好"
  ],
  "settings.appearance": [
    "Appearance",
    "外观"
  ],
  "settings.ai": [
    "AI Configuration",
    "AI 模型配置"
  ],
  "shortcuts.toggleSidebar": [
    "Expand or collapse the sidebar",
    "展开或收起侧边栏"
  ],
  "shortcuts.goBack": [
    "Go back one page",
    "后退一页"
  ],
  "shortcuts.goForward": [
    "Go forward one page",
    "前进一页"
  ]
};

describe("Batch A i18n assembly — bundle-level contract", () => {
  it("lands all 63 new keys in both bundles", () => {
    expect(Object.keys(NEW_KEYS)).toHaveLength(63);
    for (const key of Object.keys(NEW_KEYS)) {
      for (const locale of LOCALES) {
        expect(hasTranslation(locale, key), `${locale} ${key}`).toBe(true);
      }
    }
  });

  it.each(Object.entries(NEW_KEYS))(
    "resolves %s to the frozen value in both locales",
    (key, [en, zh]) => {
      expect(translate("en", key)).toBe(en);
      expect(translate("zh-CN", key)).toBe(zh);
    },
  );

  it.each(Object.entries(REUSED_KEYS))(
    "keeps the pre-existing value of reused key %s",
    (key, [en, zh]) => {
      expect(translate("en", key)).toBe(en);
      expect(translate("zh-CN", key)).toBe(zh);
    },
  );
});

describe("Batch A i18n assembly — rendered pages show no raw keys", () => {
  const cases = [
    { name: "NotificationsSettings", node: <NotificationsSettings />, enText: "Notifications", zhText: "通知" },
    { name: "ShortcutsSettings", node: <ShortcutsSettings />, enText: "Shortcuts", zhText: "快捷键" },
    { name: "AudioSettings", node: <AudioSettings />, enText: "Audio", zhText: "音频" },
  ] as const;

  for (const locale of LOCALES) {
    it.each(cases)("$name renders translated copy in " + locale, ({ node, enText, zhText }) => {
      const { container } = render(<I18nProvider initialLocale={locale}>{node}</I18nProvider>);
      const text = container.textContent ?? "";
      // A missing bundle entry would surface as the raw "settings.*"/"shortcuts.*" key.
      expect(text).not.toMatch(/settings\.[a-z]/);
      expect(text).not.toMatch(/shortcuts\.[a-z]/);
      expect(text).toContain(locale === "en" ? enText : zhText);
    });
  }
});

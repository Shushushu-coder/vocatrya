"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/i18n";
import type { Locale } from "@/i18n";
import { Badge } from "../ui/badge";

// INT-01 owns the shared message bundles; until the declared keys land,
// t() echoes the key and the paired fallback keeps the page readable.
function useCopy() {
  const { t, locale } = useI18n();
  return (key: string, fallback: Record<Locale, string>) => {
    const translated = t(key);
    return translated === key ? fallback[locale] : translated;
  };
}

function SettingRow({
  name,
  description,
  aside,
}: {
  name: string;
  description: string;
  aside: ReactNode;
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
      <div className="shrink-0">{aside}</div>
    </div>
  );
}

// Audited at baseline 59499771: no getUserMedia, no AudioContext, no
// enumerateDevices/setSinkId, no SpeechRecognition, no audio backend. The
// single media call in the app is screen capture via getDisplayMedia with
// audio explicitly disabled (prompt-input.tsx). Nothing here may pretend
// to be configurable, and the page must never request media permission —
// it is a static, honest capability statement.
function AudioSettings() {
  const copy = useCopy();

  const notProvided = (
    <Badge variant="outline">
      {copy("settings.capabilityNotProvided", {
        "zh-CN": "未提供",
        en: "Not provided",
      })}
    </Badge>
  );

  return (
    <div className="space-y-4" data-testid="audio-settings">
      <div>
        <h3 className="text-lg font-medium">
          {copy("settings.audio", {
            "zh-CN": "音频",
            en: "Audio",
          })}
        </h3>
        <p className="text-sm text-muted-foreground break-words">
          {copy("settings.audioDescription", {
            "zh-CN":
              "当前版本未集成音频输入、输出或设备管理能力，本页不提供任何可保存的音频设置。",
            en: "This version integrates no audio input, output, or device-management capability, so no audio settings are offered here.",
          })}
        </p>
      </div>

      <div className="divide-y">
        <SettingRow
          name={copy("settings.audioMicrophoneTitle", {
            "zh-CN": "麦克风输入",
            en: "Microphone input",
          })}
          description={copy("settings.audioMicrophoneDescription", {
            "zh-CN": "应用不采集音频，也不会请求麦克风权限。",
            en: "The app does not capture audio and never requests microphone permission.",
          })}
          aside={notProvided}
        />
        <SettingRow
          name={copy("settings.audioOutputTitle", {
            "zh-CN": "音频输出与设备切换",
            en: "Audio output & device switching",
          })}
          description={copy("settings.audioOutputDescription", {
            "zh-CN": "没有音频播放或音频设备选择能力。",
            en: "There is no audio playback or audio device selection capability.",
          })}
          aside={notProvided}
        />
        <SettingRow
          name={copy("settings.audioTranscriptionTitle", {
            "zh-CN": "语音转写与识别",
            en: "Speech transcription & recognition",
          })}
          description={copy("settings.audioTranscriptionDescription", {
            "zh-CN": "没有语音转文字能力。",
            en: "No speech-to-text capability exists.",
          })}
          aside={notProvided}
        />
        <SettingRow
          name={copy("settings.audioRecordingTitle", {
            "zh-CN": "录音测试",
            en: "Recording test",
          })}
          description={copy("settings.audioRecordingDescription", {
            "zh-CN": "没有录音功能可供测试。",
            en: "There is no recording feature to test.",
          })}
          aside={notProvided}
        />
      </div>

      <p className="text-sm text-muted-foreground break-words">
        {copy("settings.audioFootnote", {
          "zh-CN":
            "应用内唯一的媒体调用是 AI 输入框的屏幕截图（明确不含音轨）。接入真实音频能力后，本页将展示实际设置项与状态。",
          en: "The only media call in the app is screen capture in the AI input (explicitly without audio). Once real audio capability is integrated, this page will list the actual settings and states.",
        })}
      </p>
    </div>
  );
}

export default AudioSettings;

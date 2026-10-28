"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "@/i18n";
import type { Locale, TranslationParams } from "@/i18n";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  getFromLocalStorage,
  saveToLocalStorage,
} from "@/utils/localstorage.utils";
import { cn } from "@/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { controlStyles } from "../ui/control-styles";

// INT-01 owns the shared message bundles; until the declared keys land,
// t() echoes the key and the paired fallback keeps the page readable.
function useCopy() {
  const { t, locale } = useI18n();
  return (
    key: string,
    fallback: Record<Locale, string>,
    params?: TranslationParams,
  ) => {
    const translated = t(key, params);
    if (translated !== key) return translated;
    const text = fallback[locale];
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name: string) =>
      params[name] !== undefined ? String(params[name]) : match,
    );
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

const RECORDING_LIMIT_MS = 15_000;

// The mic row collapses every failure into one of these honest states; each
// one keeps a retry path so a transient failure never strands the page.
type MicState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | { kind: "active" }
  | { kind: "denied" }
  | { kind: "no-device" }
  | { kind: "busy" }
  | { kind: "lost" }
  | { kind: "unsupported" }
  | { kind: "error"; detail: string };

type RecordError = "unsupported" | { detail: string } | null;

interface InputDevice {
  deviceId: string;
  label: string;
}

function errorName(err: unknown): string {
  if (err instanceof DOMException) return err.name;
  const named = err as { name?: unknown } | null;
  return typeof named?.name === "string"
    ? named.name
    : err instanceof Error
      ? err.message
      : String(err);
}

function classifyMicError(err: unknown): MicState {
  switch (errorName(err)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return { kind: "denied" };
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return { kind: "no-device" };
    case "NotReadableError":
    case "AbortError":
      return { kind: "busy" };
    default:
      return { kind: "error", detail: errorName(err) };
  }
}

function readSavedDeviceId(): string | null {
  try {
    const saved: unknown = getFromLocalStorage(
      APP_CONSTANTS.AUDIO_INPUT_DEVICE_STORAGE_KEY,
      null,
    );
    return typeof saved === "string" && saved.length > 0 ? saved : null;
  } catch {
    return null;
  }
}

// Phase-1 audio surface: microphone pick (persisted on-device), a live input
// level meter, and a short in-memory recording test. Speech transcription and
// output-device switching are deliberately out of scope; the transcription
// row keeps its honest "Not provided" badge.
function AudioSettings() {
  const copy = useCopy();

  const [micState, setMicState] = useState<MicState>({ kind: "idle" });
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [hasLevelMeter, setHasLevelMeter] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordUrl, setRecordUrl] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<RecordError>(null);

  // Invalidates async continuations after a newer acquire or unmount.
  const generationRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const levelSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafRef = useRef(0);
  const levelFillRef = useRef<HTMLDivElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef(0);
  const recordUrlRef = useRef<string | null>(null);
  const deviceListenerRef = useRef<(() => void) | null>(null);
  const selectedRef = useRef("");

  const replaceRecordUrl = useCallback((url: string | null) => {
    if (recordUrlRef.current && recordUrlRef.current !== url) {
      URL.revokeObjectURL(recordUrlRef.current);
    }
    recordUrlRef.current = url;
    setRecordUrl(url);
  }, []);

  const stopRecording = useCallback((keepOutput: boolean) => {
    window.clearTimeout(recordTimerRef.current);
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    if (!recorder) return;
    if (!keepOutput) {
      // Discard path: drop handlers so no blob URL is ever produced.
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
    }
    if (recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Already stopped.
      }
    }
  }, []);

  const stopStreamAndMeter = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    if (levelFillRef.current) levelFillRef.current.style.width = "0%";
    levelSourceRef.current?.disconnect();
    levelSourceRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context) void context.close().catch(() => {});
    setHasLevelMeter(false);
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  const enumerateInputs = useCallback(async (): Promise<InputDevice[]> => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return list
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({
          deviceId: device.deviceId || `audioinput-${index}`,
          label: device.label || "",
        }));
    } catch {
      return [];
    }
  }, []);

  const startLevelMeter = useCallback((stream: MediaStream) => {
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    try {
      const context = new Ctor();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      audioContextRef.current = context;
      levelSourceRef.current = source;
      setHasLevelMeter(true);
      const buffer = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const value of buffer) {
          const centered = (value - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / buffer.length);
        const level = Math.min(1, rms * 2.8);
        if (levelFillRef.current) {
          levelFillRef.current.style.width = `${Math.round(level * 100)}%`;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Meter is best-effort; the mic still works without it.
      void audioContextRef.current?.close().catch(() => {});
      audioContextRef.current = null;
      levelSourceRef.current = null;
      setHasLevelMeter(false);
    }
  }, []);

  const acquireMic = useCallback(
    async (preferDeviceId?: string) => {
      const generation = ++generationRef.current;
      const media = navigator.mediaDevices;
      setRecordError(null);
      if (!media?.getUserMedia) {
        setMicState({ kind: "unsupported" });
        return;
      }
      stopRecording(false);
      replaceRecordUrl(null);
      stopStreamAndMeter();
      setMicState({ kind: "requesting" });

      let stream: MediaStream;
      try {
        stream = await media.getUserMedia({
          audio: preferDeviceId
            ? { deviceId: { ideal: preferDeviceId } }
            : true,
        });
      } catch (err) {
        if (generation === generationRef.current) {
          setMicState(classifyMicError(err));
        }
        return;
      }
      if (generation !== generationRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;

      const track = stream.getAudioTracks()[0];
      if (track) {
        // A mid-session unplug ends the track; surfaced as an honest error.
        track.onended = () => {
          stopRecording(false);
          replaceRecordUrl(null);
          stopStreamAndMeter();
          selectedRef.current = "";
          setSelectedId("");
          setMicState({ kind: "lost" });
          void enumerateInputs().then(setDevices);
        };
      }

      setMicState({ kind: "active" });
      startLevelMeter(stream);

      // Device labels are only meaningful after a grant.
      const inputs = await enumerateInputs();
      if (generation !== generationRef.current) return;
      const actual = track?.getSettings().deviceId;
      if (inputs.length === 0 && track) {
        // A live stream proves a device exists even when enumeration comes
        // back empty; surface it so the picker never renders blank.
        inputs.push({ deviceId: actual || "default", label: "" });
      }
      setDevices(inputs);
      if (!deviceListenerRef.current && media.addEventListener) {
        const onDeviceChange = () => {
          void enumerateInputs().then(setDevices);
        };
        deviceListenerRef.current = onDeviceChange;
        media.addEventListener("devicechange", onDeviceChange);
      }
      if (inputs.length === 0) return;

      const pick = (id: string | null | undefined) =>
        id ? inputs.find((device) => device.deviceId === id) : undefined;
      const chosen =
        pick(actual) ?? pick(preferDeviceId) ?? pick(readSavedDeviceId()) ?? inputs[0];
      selectedRef.current = chosen.deviceId;
      setSelectedId(chosen.deviceId);
      saveToLocalStorage(
        APP_CONSTANTS.AUDIO_INPUT_DEVICE_STORAGE_KEY,
        chosen.deviceId,
      );
    },
    [
      enumerateInputs,
      replaceRecordUrl,
      startLevelMeter,
      stopRecording,
      stopStreamAndMeter,
    ],
  );

  const enableMic = useCallback(() => {
    void acquireMic(selectedRef.current || readSavedDeviceId() || undefined);
  }, [acquireMic]);

  const handleSelectDevice = useCallback(
    (deviceId: string) => {
      if (!deviceId || deviceId === selectedRef.current) return;
      selectedRef.current = deviceId;
      setSelectedId(deviceId);
      saveToLocalStorage(
        APP_CONSTANTS.AUDIO_INPUT_DEVICE_STORAGE_KEY,
        deviceId,
      );
      void acquireMic(deviceId);
    },
    [acquireMic],
  );

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    setRecordError(null);
    if (!stream || micState.kind !== "active") return;
    if (typeof MediaRecorder === "undefined") {
      setRecordError("unsupported");
      return;
    }
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch (err) {
      setRecordError({ detail: errorName(err) });
      return;
    }
    replaceRecordUrl(null);
    recordChunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordChunksRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      const chunks = recordChunksRef.current;
      recordChunksRef.current = [];
      if (chunks.length === 0 || typeof URL.createObjectURL !== "function") {
        return;
      }
      const blob = new Blob(chunks, {
        type: recorder.mimeType || "audio/webm",
      });
      replaceRecordUrl(URL.createObjectURL(blob));
    };
    recorder.onerror = () => setRecordError({ detail: "MediaRecorder" });
    recorderRef.current = recorder;
    try {
      recorder.start();
    } catch (err) {
      recorderRef.current = null;
      setRecordError({ detail: errorName(err) });
      return;
    }
    setRecording(true);
    recordTimerRef.current = window.setTimeout(() => {
      stopRecording(true);
    }, RECORDING_LIMIT_MS);
  }, [micState.kind, replaceRecordUrl, stopRecording]);

  // Every resource the mic path can hold is released on unmount: stream
  // tracks, the AudioContext, the rAF loop, the recorder, the blob URL and
  // the devicechange listener.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      stopRecording(false);
      replaceRecordUrl(null);
      stopStreamAndMeter();
      const listener = deviceListenerRef.current;
      deviceListenerRef.current = null;
      if (listener && navigator.mediaDevices?.removeEventListener) {
        navigator.mediaDevices.removeEventListener("devicechange", listener);
      }
    };
  }, [replaceRecordUrl, stopRecording, stopStreamAndMeter]);

  const notProvided = (
    <Badge variant="outline">
      {copy("settings.capabilityNotProvided", {
        "zh-CN": "未提供",
        en: "Not provided",
      })}
    </Badge>
  );

  const micErrorText = (() => {
    switch (micState.kind) {
      case "denied":
        return copy("settings.audioMicDenied", {
          "zh-CN": "麦克风权限被拒绝。请在系统或浏览器权限设置中允许访问后重试。",
          en: "Microphone access was denied. Allow microphone access in your system or browser permission settings, then retry.",
        });
      case "no-device":
        return copy("settings.audioMicNoDevice", {
          "zh-CN": "未检测到麦克风。",
          en: "No microphone was detected.",
        });
      case "busy":
        return copy("settings.audioMicBusy", {
          "zh-CN": "无法打开麦克风——设备可能被其他应用占用或被系统阻止。",
          en: "The microphone could not be opened — it may be in use by another app or blocked by the system.",
        });
      case "lost":
        return copy("settings.audioMicLost", {
          "zh-CN": "所选麦克风已断开连接。",
          en: "The selected microphone was disconnected.",
        });
      case "unsupported":
        return copy("settings.audioMicUnsupported", {
          "zh-CN": "当前环境不支持访问麦克风。",
          en: "This environment does not expose microphone access.",
        });
      case "error":
        return copy(
          "settings.audioMicError",
          {
            "zh-CN": "无法启用麦克风（{detail}）。",
            en: "The microphone could not be enabled ({detail}).",
          },
          { detail: micState.detail },
        );
      default:
        return null;
    }
  })();

  const recordErrorText = (() => {
    if (recordError === "unsupported") {
      return copy("settings.audioRecordingUnsupported", {
        "zh-CN": "当前环境不支持录音。",
        en: "Recording is not supported in this environment.",
      });
    }
    if (recordError) {
      return copy(
        "settings.audioRecordingError",
        {
          "zh-CN": "录音失败（{detail}）。",
          en: "Recording failed ({detail}).",
        },
        { detail: recordError.detail },
      );
    }
    return null;
  })();

  const micActive = micState.kind === "active";
  const micFailed =
    micState.kind !== "idle" &&
    micState.kind !== "requesting" &&
    micState.kind !== "active";
  const needsMicHint =
    micState.kind === "requesting"
      ? copy("settings.audioMicEnabling", {
          "zh-CN": "正在请求权限…",
          en: "Requesting permission…",
        })
      : copy("settings.audioNeedsMicEnabled", {
          "zh-CN": "请先启用麦克风。",
          en: "Enable the microphone first.",
        });
  const micButtonLabel =
    micState.kind === "requesting"
      ? copy("settings.audioMicEnabling", {
          "zh-CN": "正在请求权限…",
          en: "Requesting permission…",
        })
      : micFailed
        ? copy("settings.audioMicRetry", {
            "zh-CN": "重试",
            en: "Retry",
          })
        : copy("settings.audioMicEnable", {
            "zh-CN": "启用麦克风",
            en: "Enable microphone",
          });

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
          {copy("settings.audioPageDescription", {
            "zh-CN":
              "选择麦克风、查看输入电平并做一段短时录音测试。仅在启用麦克风时才会请求权限。",
            en: "Pick a microphone, check the input level, and run a short recording test. Permission is only requested when you enable the microphone.",
          })}
        </p>
      </div>

      <div className="divide-y">
        <SettingRow
          name={copy("settings.audioMicrophoneTitle", {
            "zh-CN": "麦克风输入",
            en: "Microphone input",
          })}
          description={copy("settings.audioMicDescription", {
            "zh-CN": "选择录音使用的麦克风；选择结果保存在本机，下次自动生效。",
            en: "Choose the microphone used for recording; the selection is stored on this device and applied automatically next time.",
          })}
          aside={
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-2">
                {devices.length > 0 ? (
                  <select
                    className={cn(controlStyles, "h-9 w-56 px-2")}
                    value={selectedId}
                    onChange={(event) =>
                      handleSelectDevice(event.target.value)
                    }
                    disabled={micState.kind === "requesting"}
                    aria-label={copy("settings.audioMicSelectLabel", {
                      "zh-CN": "选择麦克风",
                      en: "Select microphone",
                    })}
                    data-testid="audio-mic-select"
                  >
                    {devices.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label ||
                          copy(
                            "settings.audioMicUnknownDevice",
                            {
                              "zh-CN": "麦克风 {number}",
                              en: "Microphone {number}",
                            },
                            { number: index + 1 },
                          )}
                      </option>
                    ))}
                  </select>
                ) : null}
                {!micActive ? (
                  <Button
                    size="sm"
                    onClick={enableMic}
                    disabled={micState.kind === "requesting"}
                    data-testid="audio-mic-enable"
                  >
                    {micButtonLabel}
                  </Button>
                ) : null}
              </div>
              {micErrorText ? (
                <p
                  role="alert"
                  className="max-w-72 text-right text-sm text-destructive"
                  data-testid="audio-mic-error"
                >
                  {micErrorText}
                </p>
              ) : null}
            </div>
          }
        />

        <SettingRow
          name={copy("settings.audioLevelTitle", {
            "zh-CN": "输入电平",
            en: "Input level",
          })}
          description={copy("settings.audioLevelDescription", {
            "zh-CN": "对着麦克风讲话，查看实时输入电平。",
            en: "Speak into the microphone to check the live input level.",
          })}
          aside={
            <div className="flex flex-col items-end gap-2">
              <div
                className="h-2 w-44 overflow-hidden rounded-full bg-muted"
                data-testid="audio-level-meter"
                aria-hidden
              >
                <div
                  ref={levelFillRef}
                  className="h-full rounded-full bg-primary transition-[width] duration-75"
                  style={{ width: "0%" }}
                  data-testid="audio-level-fill"
                />
              </div>
              {!hasLevelMeter ? (
                <p className="text-sm text-muted-foreground">
                  {micActive
                    ? copy("settings.audioLevelUnsupported", {
                        "zh-CN": "当前环境不支持输入电平显示。",
                        en: "Input level is not available in this environment.",
                      })
                    : needsMicHint}
                </p>
              ) : null}
            </div>
          }
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
          description={copy("settings.audioRecordingRowDescription", {
            "zh-CN":
              "录制一段短音频并立即回放；录音只保留在内存中，离开本页即丢弃（最长 15 秒）。",
            en: "Record a short clip and play it back. The recording stays in memory only and is discarded when you leave this page (up to 15 seconds).",
          })}
          aside={
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-2">
                {!micActive ? (
                  <p className="text-sm text-muted-foreground">
                    {needsMicHint}
                  </p>
                ) : recording ? (
                  <>
                    <span
                      className="text-sm text-muted-foreground"
                      data-testid="audio-record-indicator"
                    >
                      {copy("settings.audioRecordingInProgress", {
                        "zh-CN": "录音中…",
                        en: "Recording…",
                      })}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => stopRecording(true)}
                      data-testid="audio-record-stop"
                    >
                      {copy("settings.audioRecordingStop", {
                        "zh-CN": "停止",
                        en: "Stop",
                      })}
                    </Button>
                  </>
                ) : (
                  <>
                    {recordUrl ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={startRecording}
                        data-testid="audio-record-again"
                      >
                        {copy("settings.audioRecordingReRecord", {
                          "zh-CN": "重新录制",
                          en: "Record again",
                        })}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={startRecording}
                        data-testid="audio-record-start"
                      >
                        {copy("settings.audioRecordingStart", {
                          "zh-CN": "开始录音",
                          en: "Start recording",
                        })}
                      </Button>
                    )}
                  </>
                )}
              </div>
              {recordUrl && !recording ? (
                <div className="flex items-center gap-2">
                  <audio
                    controls
                    src={recordUrl}
                    aria-label={copy("settings.audioRecordingPlaybackLabel", {
                      "zh-CN": "录音回放",
                      en: "Recording playback",
                    })}
                    data-testid="audio-record-playback"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => replaceRecordUrl(null)}
                    data-testid="audio-record-discard"
                  >
                    {copy("settings.audioRecordingDiscard", {
                      "zh-CN": "丢弃",
                      en: "Discard",
                    })}
                  </Button>
                </div>
              ) : null}
              {recordErrorText ? (
                <p
                  role="alert"
                  className="max-w-72 text-right text-sm text-destructive"
                  data-testid="audio-record-error"
                >
                  {recordErrorText}
                </p>
              ) : null}
            </div>
          }
        />
      </div>

      <p className="text-sm text-muted-foreground break-words">
        {copy("settings.audioPageFootnote", {
          "zh-CN":
            "仅在点击“启用麦克风”后才会请求麦克风权限；录音不写入磁盘，离开本页即销毁；回放经系统默认输出设备播放。",
          en: "Microphone permission is requested only after you click “Enable microphone”. Recordings never touch disk and are destroyed when you leave this page; playback uses the system default output device.",
        })}
      </p>
    </div>
  );
}

export default AudioSettings;

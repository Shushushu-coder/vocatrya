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
import {
  MicClipRecorder,
  acquireMicStream,
  micErrorName,
  readSavedMicDeviceId,
  saveMicDeviceId,
  stopMediaStream,
} from "@/lib/audio/microphone";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { controlStyles } from "../ui/control-styles";
import { DictationSettingsControls } from "./DictationSettingsControls";

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

function readSavedDeviceId(): string | null {
  return readSavedMicDeviceId();
}

// Audio surface: microphone pick (persisted on-device), a live input level
// meter, a short in-memory recording test, and the dictation service config
// (AWU-DICTATION). Mic lifecycle primitives are shared with the Agent
// dictation recorder via src/lib/audio/microphone.ts; output-device
// switching stays out of scope.
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
  const clipRef = useRef<MicClipRecorder | null>(null);
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

  const stopRecording = useCallback(
    (keepOutput: boolean) => {
      window.clearTimeout(recordTimerRef.current);
      const clip = clipRef.current;
      clipRef.current = null;
      setRecording(false);
      if (!clip) return;
      if (!keepOutput) {
        // Discard path: cancel drops handlers so no blob URL is produced.
        clip.cancel();
        return;
      }
      const generation = generationRef.current;
      void clip.stop().then((blob) => {
        // A newer acquire or unmount superseded this clip — never mint a
        // blob URL nobody will revoke.
        if (generation !== generationRef.current || !blob) return;
        if (typeof URL.createObjectURL !== "function") return;
        replaceRecordUrl(URL.createObjectURL(blob));
      });
    },
    [replaceRecordUrl],
  );

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
    stopMediaStream(streamRef.current);
    streamRef.current = null;
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
      setRecordError(null);
      stopRecording(false);
      replaceRecordUrl(null);
      stopStreamAndMeter();
      setMicState({ kind: "requesting" });

      const result = await acquireMicStream(preferDeviceId);
      if (!result.ok) {
        if (generation === generationRef.current) {
          setMicState(
            result.kind === "error"
              ? { kind: "error", detail: result.detail ?? "getUserMedia" }
              : { kind: result.kind },
          );
        }
        return;
      }
      const stream = result.stream;
      if (generation !== generationRef.current) {
        stopMediaStream(stream);
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
      const media = navigator.mediaDevices;
      if (!deviceListenerRef.current && media?.addEventListener) {
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
      saveMicDeviceId(chosen.deviceId);
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
      saveMicDeviceId(deviceId);
      void acquireMic(deviceId);
    },
    [acquireMic],
  );

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    setRecordError(null);
    if (!stream || micState.kind !== "active") return;
    if (!MicClipRecorder.supported) {
      setRecordError("unsupported");
      return;
    }
    let clip: MicClipRecorder;
    try {
      clip = new MicClipRecorder(stream, {
        onError: (detail) => setRecordError({ detail }),
      });
      clip.start();
    } catch (err) {
      setRecordError({ detail: micErrorName(err) });
      return;
    }
    replaceRecordUrl(null);
    clipRef.current = clip;
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

      {/* AWU-DICTATION: the API transcription config replaces the old
          "no speech-to-text" row — provider, model and which credential
          the dictation route resolves. */}
      <DictationSettingsControls />

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

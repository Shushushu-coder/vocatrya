// SET-AUDIO phase 1: the settings audio page delivers a persisted microphone
// pick, a live input-level meter and a short in-memory recording test. All
// media APIs are mocked — permission is only requested on user click, errors
// stay honest and retriable, and every resource is released on unmount.
import {
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AudioSettings from "@/components/settings/AudioSettings";
import { APP_CONSTANTS } from "@/lib/constants";

const DEVICE_KEY = APP_CONSTANTS.AUDIO_INPUT_DEVICE_STORAGE_KEY;

interface FakeTrack {
  kind: "audio";
  label: string;
  readyState: "live" | "ended";
  deviceId: string;
  stop: () => void;
  getSettings: () => { deviceId: string };
  onended: (() => void) | null;
}

function makeTrack(deviceId: string): FakeTrack {
  const track: FakeTrack = {
    kind: "audio",
    label: `Mic ${deviceId}`,
    readyState: "live",
    deviceId,
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
    getSettings: () => ({ deviceId }),
    onended: null,
  };
  return track;
}

function makeStream(...tracks: FakeTrack[]) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function makeDevice(deviceId: string, label = "") {
  return {
    deviceId,
    kind: "audioinput",
    label: label || `Label ${deviceId}`,
    groupId: "g",
    toJSON: () => ({}),
  } as MediaDeviceInfo;
}

interface MediaMocks {
  getUserMedia: ReturnType<typeof vi.fn>;
  enumerateDevices: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  deviceChangeHandlers: Array<() => void>;
}

function installMediaDevices(overrides: Partial<MediaMocks> = {}): MediaMocks {
  const mocks: MediaMocks = {
    getUserMedia: vi.fn(),
    enumerateDevices: vi.fn(async () => []),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    deviceChangeHandlers: [],
    ...overrides,
  };
  mocks.addEventListener.mockImplementation(
    (type: string, handler: () => void) => {
      if (type === "devicechange") mocks.deviceChangeHandlers.push(handler);
    },
  );
  Object.defineProperty(navigator, "mediaDevices", {
    value: mocks,
    configurable: true,
    writable: true,
  });
  return mocks;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  source = { connect: vi.fn(), disconnect: vi.fn() };
  analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    getByteTimeDomainData: (buffer: Uint8Array) => {
      buffer.fill(200);
    },
  };
  close = vi.fn(() => Promise.resolve());
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource() {
    return this.source;
  }
  createAnalyser() {
    return this.analyser;
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["clip"], { type: this.mimeType }),
    });
    this.onstop?.();
  });
  constructor(public stream: unknown) {
    FakeMediaRecorder.instances.push(this);
  }
}

beforeEach(() => {
  localStorage.clear();
  FakeAudioContext.instances = [];
  FakeMediaRecorder.instances = [];
});

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubObjectUrls() {
  const createObjectURL = vi.fn(() => "blob:fake-clip");
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    value: createObjectURL,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: revokeObjectURL,
    configurable: true,
    writable: true,
  });
  return { createObjectURL, revokeObjectURL };
}

async function enableMic(
  mocks: MediaMocks,
  track = makeTrack("dev-1"),
  devices = [makeDevice("dev-1")],
) {
  mocks.getUserMedia.mockResolvedValue(makeStream(track));
  mocks.enumerateDevices.mockResolvedValue(devices);
  const user = userEvent.setup();
  render(<AudioSettings />);
  await user.click(screen.getByTestId("audio-mic-enable"));
  await screen.findByTestId("audio-mic-select");
  return { user, track };
}

describe("AudioSettings — permission gate", () => {
  it("does not touch any media API before the user enables the microphone", () => {
    const mocks = installMediaDevices();
    render(<AudioSettings />);
    const page = screen.getByTestId("audio-settings");
    expect(screen.getByTestId("audio-mic-enable")).toHaveTextContent(
      "Enable microphone",
    );
    expect(within(page).getAllByText("Not provided")).toHaveLength(1);
    expect(mocks.getUserMedia).not.toHaveBeenCalled();
    expect(mocks.enumerateDevices).not.toHaveBeenCalled();
    expect(mocks.addEventListener).not.toHaveBeenCalled();
  });

  it("reports an unsupported environment honestly", async () => {
    // No navigator.mediaDevices at all.
    const user = userEvent.setup();
    render(<AudioSettings />);
    await user.click(screen.getByTestId("audio-mic-enable"));
    expect(await screen.findByTestId("audio-mic-error")).toHaveTextContent(
      "does not expose microphone access",
    );
  });
});

describe("AudioSettings — device enumeration & persistence", () => {
  it("enumerates inputs after the grant and restores the saved device", async () => {
    const mocks = installMediaDevices();
    localStorage.setItem(DEVICE_KEY, JSON.stringify("dev-2"));
    const { track } = await enableMic(
      mocks,
      makeTrack("dev-2"),
      [makeDevice("dev-1"), makeDevice("dev-2")],
    );
    expect(mocks.getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { ideal: "dev-2" } },
    });
    const select = screen.getByTestId("audio-mic-select") as HTMLSelectElement;
    expect(select.value).toBe("dev-2");
    expect(
      within(select).getByRole("option", { name: "Label dev-1" }),
    ).toBeInTheDocument();
    expect(track.onended).toBeInstanceOf(Function);
    expect(mocks.addEventListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );
    expect(JSON.parse(localStorage.getItem(DEVICE_KEY)!)).toBe("dev-2");
  });

  it("falls back to the actual device when the saved one is gone", async () => {
    const mocks = installMediaDevices();
    localStorage.setItem(DEVICE_KEY, JSON.stringify("dev-gone"));
    await enableMic(mocks, makeTrack("dev-1"), [makeDevice("dev-1")]);
    const select = screen.getByTestId("audio-mic-select") as HTMLSelectElement;
    expect(select.value).toBe("dev-1");
    expect(JSON.parse(localStorage.getItem(DEVICE_KEY)!)).toBe("dev-1");
  });

  it("re-enumerates when a devicechange event fires", async () => {
    const mocks = installMediaDevices();
    await enableMic(mocks);
    expect(mocks.enumerateDevices).toHaveBeenCalledTimes(1);
    mocks.enumerateDevices.mockResolvedValue([
      makeDevice("dev-1"),
      makeDevice("dev-3"),
    ]);
    await act(async () => {
      for (const handler of mocks.deviceChangeHandlers) handler();
    });
    await waitFor(() =>
      expect(mocks.enumerateDevices).toHaveBeenCalledTimes(2),
    );
    expect(
      within(screen.getByTestId("audio-mic-select")).getByRole("option", {
        name: "Label dev-3",
      }),
    ).toBeInTheDocument();
  });
});

describe("AudioSettings — error states", () => {
  it("reports denied permission and lets the user retry", async () => {
    const mocks = installMediaDevices();
    mocks.getUserMedia
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"))
      .mockResolvedValue(makeStream(makeTrack("dev-1")));
    mocks.enumerateDevices.mockResolvedValue([makeDevice("dev-1")]);
    const user = userEvent.setup();
    render(<AudioSettings />);
    await user.click(screen.getByTestId("audio-mic-enable"));
    expect(await screen.findByTestId("audio-mic-error")).toHaveTextContent(
      "denied",
    );
    await user.click(screen.getByTestId("audio-mic-enable"));
    await screen.findByTestId("audio-mic-select");
    expect(mocks.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("reports an absent microphone honestly", async () => {
    const mocks = installMediaDevices();
    mocks.getUserMedia.mockRejectedValue(
      new DOMException("missing", "NotFoundError"),
    );
    const user = userEvent.setup();
    render(<AudioSettings />);
    await user.click(screen.getByTestId("audio-mic-enable"));
    expect(await screen.findByTestId("audio-mic-error")).toHaveTextContent(
      "No microphone was detected",
    );
  });

  it("reports an unopenable source (busy/blocked) honestly", async () => {
    const mocks = installMediaDevices();
    mocks.getUserMedia.mockRejectedValue(
      new DOMException("Could not start audio source", "NotReadableError"),
    );
    const user = userEvent.setup();
    render(<AudioSettings />);
    await user.click(screen.getByTestId("audio-mic-enable"));
    expect(await screen.findByTestId("audio-mic-error")).toHaveTextContent(
      "could not be opened",
    );
  });

  it("flags a mid-session unplug and keeps a retry path", async () => {
    const mocks = installMediaDevices();
    const { track } = await enableMic(mocks);
    await act(async () => {
      track.onended?.();
    });
    expect(await screen.findByTestId("audio-mic-error")).toHaveTextContent(
      "disconnected",
    );
    expect(track.stop).toHaveBeenCalled();
    expect(screen.getByTestId("audio-mic-enable")).toHaveTextContent("Retry");
  });
});

describe("AudioSettings — input level", () => {
  it("drives the meter through AudioContext once granted", async () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const mocks = installMediaDevices();
    await enableMic(mocks);
    expect(FakeAudioContext.instances).toHaveLength(1);
    const fill = screen.getByTestId("audio-level-fill");
    await waitFor(() => expect(fill.style.width).not.toBe("0%"));
  });

  it("keeps the page honest when AudioContext is unavailable", async () => {
    const mocks = installMediaDevices();
    await enableMic(mocks);
    expect(screen.getByTestId("audio-level-meter")).toBeInTheDocument();
    expect(
      screen.getByText(/Input level is not available/i),
    ).toBeInTheDocument();
  });
});

describe("AudioSettings — recording test", () => {
  it("records a clip, plays it back and discards it without touching disk", async () => {
    const { revokeObjectURL } = stubObjectUrls();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const mocks = installMediaDevices();
    await enableMic(mocks);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("audio-record-start"));
    expect(screen.getByTestId("audio-record-indicator")).toBeInTheDocument();
    await user.click(screen.getByTestId("audio-record-stop"));
    const playback = await screen.findByTestId("audio-record-playback");
    expect(playback).toHaveAttribute("src", "blob:fake-clip");
    await user.click(screen.getByTestId("audio-record-discard"));
    expect(
      screen.queryByTestId("audio-record-playback"),
    ).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-clip");
  });

  it("keeps controls honest when MediaRecorder is missing", async () => {
    const mocks = installMediaDevices();
    await enableMic(mocks);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("audio-record-start"));
    expect(await screen.findByTestId("audio-record-error")).toHaveTextContent(
      "not supported",
    );
  });
});

describe("AudioSettings — resource cleanup", () => {
  it("releases tracks, AudioContext, listener and blob URL on unmount", async () => {
    const { revokeObjectURL } = stubObjectUrls();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame");
    const mocks = installMediaDevices();
    const track = makeTrack("dev-1");
    mocks.getUserMedia.mockResolvedValue(makeStream(track));
    mocks.enumerateDevices.mockResolvedValue([makeDevice("dev-1")]);
    const user = userEvent.setup();
    const { unmount } = render(<AudioSettings />);
    await user.click(screen.getByTestId("audio-mic-enable"));
    await screen.findByTestId("audio-mic-select");
    await user.click(screen.getByTestId("audio-record-start"));
    await user.click(screen.getByTestId("audio-record-stop"));
    await screen.findByTestId("audio-record-playback");

    unmount();

    expect(track.stop).toHaveBeenCalled();
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalled();
    expect(mocks.removeEventListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );
    expect(cancelSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-clip");
  });

  it("abandons an in-progress recording without producing a blob on unmount", async () => {
    const { createObjectURL } = stubObjectUrls();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const mocks = installMediaDevices();
    const track = makeTrack("dev-1");
    mocks.getUserMedia.mockResolvedValue(makeStream(track));
    mocks.enumerateDevices.mockResolvedValue([makeDevice("dev-1")]);
    const user = userEvent.setup();
    const { unmount } = render(<AudioSettings />);
    await user.click(screen.getByTestId("audio-mic-enable"));
    await screen.findByTestId("audio-mic-select");
    await user.click(screen.getByTestId("audio-record-start"));

    unmount();

    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder.stop).toHaveBeenCalled();
    // Handlers are detached before stop so no object URL is ever minted.
    expect(recorder.onstop).toBeNull();
    expect(recorder.ondataavailable).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });
});

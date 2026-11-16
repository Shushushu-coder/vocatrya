// @vitest-environment node
import { prepareDictationAudio } from "@/lib/dictation/prepareAudio";

afterEach(() => vi.unstubAllGlobals());

function decoder(samples: Float32Array, duration = 1) {
  const close = vi.fn(async () => {});
  vi.stubGlobal("AudioContext", class {
    close = close;
    decodeAudioData = vi.fn(async () => ({ duration, numberOfChannels: 1, length: samples.length,
      getChannelData: () => samples }));
  });
  return close;
}

it("rejects a silent recording before uploading and releases the decoder", async () => {
  const close = decoder(new Float32Array(16000));
  await expect(prepareDictationAudio(new Blob(["audio"], { type: "audio/webm" })))
    .rejects.toMatchObject({ code: "DICTATION_NO_SPEECH" });
  expect(close).toHaveBeenCalledOnce();
});

it("retains a supported audible clip without re-encoding", async () => {
  decoder(new Float32Array([0.1, -0.1]));
  const blob = new Blob(["audio"], { type: "audio/webm;codecs=opus" });
  expect(await prepareDictationAudio(blob)).toBe(blob);
});

it("converts an MP4 recording into real PCM WAV bytes", async () => {
  decoder(new Float32Array([0.1, -0.1]));
  const start = vi.fn();
  vi.stubGlobal("OfflineAudioContext", class {
    destination = {};
    createBufferSource() { return { connect: vi.fn(), start, buffer: null }; }
    async startRendering() { return { getChannelData: () => new Float32Array([1, -1, 0]) }; }
  });
  const blob = await prepareDictationAudio(new Blob(["mp4"], { type: "audio/mp4" }));
  const bytes = Buffer.from(await blob.arrayBuffer());
  expect(blob.type).toBe("audio/wav");
  expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
  expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
  expect(bytes.readUInt32LE(24)).toBe(16000);
  expect(bytes.readUInt32LE(40)).toBe(6);
  expect(bytes.readInt16LE(44)).toBe(32767);
  expect(bytes.readInt16LE(46)).toBe(-32768);
});

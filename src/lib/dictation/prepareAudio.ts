import { DictationClientError } from "./errors";
import { DICTATION_ERROR_CODES } from "./config";

/** Inspect the decoded recording; convert MP4 containers to actual WAV bytes
 * for providers that accept WAV but not Chromium's MP4 container. */
export async function prepareDictationAudio(blob: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (decoded.duration < 0.15) {
      throw new DictationClientError(DICTATION_ERROR_CODES.INVALID_AUDIO, "The recording is too short");
    }
    let energy = 0;
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      for (const sample of decoded.getChannelData(channel)) energy += sample * sample;
    }
    if (Math.sqrt(energy / (decoded.length * decoded.numberOfChannels)) < 0.0001) {
      throw new DictationClientError(DICTATION_ERROR_CODES.NO_SPEECH, "No audible speech was recorded");
    }
    if (blob.type.split(";")[0].toLowerCase() !== "audio/mp4") return blob;
    const renderer = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const source = renderer.createBufferSource();
    source.buffer = decoded;
    source.connect(renderer.destination);
    source.start();
    const rendered = await renderer.startRendering();
    const samples = rendered.getChannelData(0);
    const bytes = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(bytes);
    const label = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    label(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); label(8, "WAVE");
    label(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, "data");
    view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, i) => {
      const value = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true);
    });
    return new Blob([bytes], { type: "audio/wav" });
  } catch (error) {
    if (error instanceof DictationClientError) throw error;
    throw new DictationClientError(DICTATION_ERROR_CODES.INVALID_AUDIO, "The recording could not be decoded");
  } finally {
    await context.close().catch(() => {});
  }
}

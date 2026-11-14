// AWU-DICTATION / D7 draft insertion: the transcript lands inside the owned
// draft — appended at the end, or at the supplied selection — never
// replacing existing text wholesale and never triggering a send.
import { insertDictationText } from "@/lib/dictation/insert";

describe("insertDictationText", () => {
  it("inserts into an empty draft and places the cursor after the text", () => {
    const result = insertDictationText("", "hello world");
    expect(result.text).toBe("hello world");
    expect(result.cursor).toBe("hello world".length);
  });

  it("appends to a non-empty draft with exactly one separating space", () => {
    const result = insertDictationText("draft", "more");
    expect(result.text).toBe("draft more");
  });

  it("does not double a space when the draft already ends in whitespace", () => {
    const result = insertDictationText("draft ", "more");
    expect(result.text).toBe("draft more");
  });

  it("inserts at a collapsed selection in the middle of the draft", () => {
    const result = insertDictationText("ab cd", "XX", { start: 3, end: 3 });
    expect(result.text).toBe("ab XX cd");
    expect(result.cursor).toBe(6);
  });

  it("adds a trailing space when text follows the insertion point", () => {
    const result = insertDictationText("ab cd", "XX", { start: 2, end: 2 });
    expect(result.text).toBe("ab XX cd");
  });

  it("replaces an active selection, not the whole draft", () => {
    const result = insertDictationText("ab cd", "XX", { start: 0, end: 2 });
    expect(result.text).toBe("XX cd");
    expect(result.cursor).toBe(2);
  });

  it("never overwrites the draft for an empty transcript", () => {
    for (const transcript of ["", "   ", "\n\t"]) {
      const result = insertDictationText("keep me", transcript);
      expect(result.text).toBe("keep me");
      expect(result.cursor).toBe("keep me".length);
    }
  });

  it("trims the transcript but keeps its inner spacing", () => {
    const result = insertDictationText("", "  hello  world  ");
    expect(result.text).toBe("hello  world");
  });

  it("clamps out-of-range selection offsets to the draft", () => {
    const result = insertDictationText("abc", "XX", { start: -5, end: 1 });
    expect(result.text).toBe("XX bc");
    expect(result.cursor).toBe(3);
  });
});

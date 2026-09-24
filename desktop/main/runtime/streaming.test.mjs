// Streaming parser tests — the normalized {text-delta|completed|error}
// contract every vendor mechanism is verified against. Covers NDJSON
// chunk-boundary handling, UTF-8 splits, cumulative snapshot diffing,
// non-content event rejection, and terminal semantics. No process is
// spawned — parsers consume synthetic chunk sequences.
import { describe, expect, it } from "vitest";
import streaming from "./streaming.js";

const {
  STREAM_ABORTED_CODE,
  STREAM_FAILURE_CODES,
  createAnthropicStreamParser,
  createCodexStreamParser,
  createCumulativeDiffer,
  createCursorStreamParser,
  createNdjsonStreamParser,
  createOpencodeStreamParser,
  createPlainTextStreamParser,
} = streaming;

const enc = new TextEncoder();

// Feeds a string through the parser as Buffer chunks of `size` bytes —
// arbitrary boundaries, including inside multi-byte UTF-8 sequences.
function feedChunked(parser, text, size = 7) {
  const bytes = enc.encode(text);
  const events = [];
  for (let i = 0; i < bytes.length; i += size) {
    events.push(...parser.push(bytes.subarray(i, i + size)));
  }
  events.push(...parser.finish());
  return events;
}

function deltas(events) {
  return events.filter((e) => e.type === "text-delta").map((e) => e.delta);
}

function completedEvent(events) {
  return events.find((e) => e.type === "completed");
}

describe("ndjson stream parser — transport handling", () => {
  const echo = (parsed) =>
    parsed.type === "delta" ? { type: "text-delta", delta: parsed.text } : null;

  it("parses a single delta line", () => {
    const parser = createNdjsonStreamParser({ mapEvent: echo });
    const events = feedChunked(parser, '{"type":"delta","text":"hello"}\n');
    expect(deltas(events)).toEqual(["hello"]);
  });

  it("parses multiple events arriving in one chunk", () => {
    const parser = createNdjsonStreamParser({ mapEvent: echo });
    const events = feedChunked(
      parser,
      '{"type":"delta","text":"a"}\n{"type":"delta","text":"b"}\n',
      1024,
    );
    expect(deltas(events)).toEqual(["a", "b"]);
  });

  it("reconstructs a JSON line split across arbitrary chunk boundaries", () => {
    const parser = createNdjsonStreamParser({ mapEvent: echo });
    const events = feedChunked(
      parser,
      '{"type":"delta","text":"split across chunks"}\n',
      3,
    );
    expect(deltas(events)).toEqual(["split across chunks"]);
  });

  it("survives multi-byte UTF-8 sequences split across chunks", () => {
    const parser = createNdjsonStreamParser({ mapEvent: echo });
    const events = feedChunked(
      parser,
      '{"type":"delta","text":"中文标点：，。！“”"}\n',
      2,
    );
    expect(deltas(events)).toEqual(["中文标点：，。！“”"]);
  });

  it("handles a final line without a trailing newline", () => {
    const parser = createNdjsonStreamParser({ mapEvent: echo });
    const events = feedChunked(
      parser,
      '{"type":"delta","text":"tail"}',
      1024,
    );
    expect(deltas(events)).toEqual(["tail"]);
  });

  it("counts malformed lines without emitting content or leaking raw text", () => {
    const parser = createNdjsonStreamParser({ mapEvent: echo });
    const events = feedChunked(
      parser,
      'garbage not json\n{"type":"delta","text":"ok"}\n{"broken":\n',
      1024,
    );
    expect(deltas(events)).toEqual(["ok"]);
    expect(parser.stats().malformedLineCount).toBe(2);
    // The malformed text never appears in any emitted event.
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain("garbage");
      expect(JSON.stringify(event)).not.toContain("broken");
    }
  });

  it("ignores non-content events (status/progress never become deltas)", () => {
    const parser = createNdjsonStreamParser({ mapEvent: echo });
    const events = feedChunked(
      parser,
      '{"type":"progress","pct":10}\n{"type":"usage","tokens":5}\n{"type":"delta","text":"x"}\n',
    );
    expect(deltas(events)).toEqual(["x"]);
    expect(parser.stats().ignoredLineCount).toBe(2);
  });
});

describe("cumulative differ", () => {
  it("diffs prefix-extending snapshots", () => {
    const differ = createCumulativeDiffer();
    expect(differ.push("H")).toEqual({ delta: "H" });
    expect(differ.push("Hel")).toEqual({ delta: "el" });
    expect(differ.push("Hello")).toEqual({ delta: "lo" });
    expect(differ.snapshot()).toBe("Hello");
  });

  it("rejects a snapshot that does not extend the previous one", () => {
    const differ = createCumulativeDiffer();
    differ.push("Hello");
    expect(differ.push("Hey")).toEqual({ inconsistent: true });
    expect(differ.isInconsistent()).toBe(true);
    // Once inconsistent, every subsequent push stays inconsistent.
    expect(differ.push("Hello world")).toEqual({ inconsistent: true });
  });

  it("rejects a shrinking snapshot", () => {
    const differ = createCumulativeDiffer();
    differ.push("Hello");
    expect(differ.push("He")).toEqual({ inconsistent: true });
  });
});

describe("opencode stream parser — cumulative part snapshots", () => {
  const line = (type, extra) => JSON.stringify({ type, ...extra }) + "\n";

  it("diffs cumulative part.text snapshots into deltas", () => {
    const parser = createOpencodeStreamParser();
    const events = feedChunked(
      parser,
      line("step_start") +
        line("text", { part: { id: "p1", type: "text", text: "H" } }) +
        line("text", { part: { id: "p1", type: "text", text: "Hello" } }) +
        line("text", { part: { id: "p1", type: "text", text: "Hello!" } }) +
        line("step_finish"),
    );
    expect(deltas(events)).toEqual(["H", "ello", "!"]);
    expect(completedEvent(events)?.text).toBe("Hello!");
  });

  it("keeps separate parts ordered by first appearance", () => {
    const parser = createOpencodeStreamParser();
    const events = feedChunked(
      parser,
      line("text", { part: { id: "a", type: "text", text: "one" } }) +
        line("text", { part: { id: "b", type: "text", text: "two" } }) +
        line("text", { part: { id: "a", type: "text", text: "one!" } }),
    );
    expect(deltas(events)).toEqual(["one", "two", "!"]);
    expect(completedEvent(events)?.text).toBe("one!two");
  });

  it("fails on a non-monotonic snapshot — never guesses a diff", () => {
    const parser = createOpencodeStreamParser();
    const events = feedChunked(
      parser,
      line("text", { part: { id: "p", type: "text", text: "Hello" } }) +
        line("text", { part: { id: "p", type: "text", text: "Hi" } }),
    );
    const error = events.find((e) => e.type === "error");
    expect(error?.code).toBe(STREAM_FAILURE_CODES.STREAM_COMPLETION_INCONSISTENT);
    // No completed event may follow an inconsistency.
    expect(completedEvent(events)).toBeUndefined();
  });

  it("maps a vendor error event", () => {
    const parser = createOpencodeStreamParser();
    const events = feedChunked(parser, line("error", { error: { message: "x" } }));
    expect(events.find((e) => e.type === "error")?.code).toBe(
      STREAM_FAILURE_CODES.STREAM_VENDOR_ERROR,
    );
  });
});

describe("anthropic/claude stream parser", () => {
  it("emits deltas from stream_event content_block_delta", () => {
    const parser = createAnthropicStreamParser();
    const events = feedChunked(
      parser,
      '{"type":"system","subtype":"init"}\n' +
        '{"type":"stream_event","event":{"type":"content_block_start"}}\n' +
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}}\n' +
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}}\n' +
        '{"type":"stream_event","event":{"type":"message_stop"}}\n',
    );
    expect(deltas(events)).toEqual(["你", "好"]);
    expect(completedEvent(events)?.text).toBe("你好");
  });

  it("diffs assistant message snapshots when no delta channel exists", () => {
    const parser = createAnthropicStreamParser();
    const events = feedChunked(
      parser,
      '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hel"}]}}\n' +
        '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hello"}]}}\n' +
        '{"type":"result","subtype":"success","result":"Hello","is_error":false}\n',
    );
    expect(deltas(events)).toEqual(["Hel", "lo"]);
    expect(completedEvent(events)?.text).toBe("Hello");
  });

  it("never double-counts text carried by both deltas and snapshots", () => {
    const parser = createAnthropicStreamParser();
    const events = feedChunked(
      parser,
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}\n' +
        '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hi"}]}}\n' +
        '{"type":"result","subtype":"success","result":"Hi","is_error":false}\n',
    );
    expect(deltas(events)).toEqual(["Hi"]);
    expect(completedEvent(events)?.text).toBe("Hi");
  });

  it("maps the result envelope error to a vendor error", () => {
    const parser = createAnthropicStreamParser();
    const events = feedChunked(
      parser,
      '{"type":"result","subtype":"error","is_error":true}\n',
    );
    expect(events.find((e) => e.type === "error")?.code).toBe(
      STREAM_FAILURE_CODES.STREAM_VENDOR_ERROR,
    );
    expect(completedEvent(events)).toBeUndefined();
  });

  it("handles bare Anthropic wire events (grok streaming-messages-json)", () => {
    const parser = createAnthropicStreamParser();
    const events = feedChunked(
      parser,
      '{"type":"message_start"}\n' +
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"ab"}}\n' +
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"cd"}}\n' +
        '{"type":"message_stop"}\n',
    );
    expect(deltas(events)).toEqual(["ab", "cd"]);
    expect(completedEvent(events)?.text).toBe("abcd");
  });
});

describe("codex stream parser — item snapshots", () => {
  const line = (obj) => JSON.stringify(obj) + "\n";

  it("diffs agent_message item snapshots", () => {
    const parser = createCodexStreamParser();
    const events = feedChunked(
      parser,
      line({ type: "thread.started" }) +
        line({ type: "turn.started" }) +
        line({
          type: "item.updated",
          item: { id: "i1", type: "agent_message", text: "Hel" },
        }) +
        line({
          type: "item.completed",
          item: { id: "i1", type: "agent_message", text: "Hello" },
        }) +
        line({ type: "turn.completed", usage: { tokens: 3 } }),
    );
    expect(deltas(events)).toEqual(["Hel", "lo"]);
    expect(completedEvent(events)?.text).toBe("Hello");
  });

  it("a single final item.completed yields exactly one delta (not streaming)", () => {
    const parser = createCodexStreamParser();
    const events = feedChunked(
      parser,
      line({ type: "turn.started" }) +
        line({
          type: "item.completed",
          item: { id: "i1", type: "agent_message", text: "whole answer" },
        }) +
        line({ type: "turn.completed" }),
    );
    // One delta from one snapshot — the verdict layer must not call this
    // multi-increment streaming.
    expect(deltas(events)).toEqual(["whole answer"]);
  });

  it("rejects non-monotonic item text", () => {
    const parser = createCodexStreamParser();
    const events = feedChunked(
      parser,
      line({
        type: "item.updated",
        item: { id: "i1", type: "agent_message", text: "Hello" },
      }) +
        line({
          type: "item.updated",
          item: { id: "i1", type: "agent_message", text: "different" },
        }),
    );
    expect(events.find((e) => e.type === "error")?.code).toBe(
      STREAM_FAILURE_CODES.STREAM_COMPLETION_INCONSISTENT,
    );
  });
});

describe("cursor stream parser — ACP session updates", () => {
  const acpChunk = (text) =>
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    }) + "\n";

  it("emits deltas from agent_message_chunk updates", () => {
    const parser = createCursorStreamParser();
    const events = feedChunked(
      parser,
      acpChunk("中") + acpChunk("文 chunk"),
    );
    expect(deltas(events)).toEqual(["中", "文 chunk"]);
    expect(completedEvent(events)?.text).toBe("中文 chunk");
  });

  it("ignores non-message session updates", () => {
    const parser = createCursorStreamParser();
    const events = feedChunked(
      parser,
      JSON.stringify({
        method: "session/update",
        params: { update: { sessionUpdate: "tool_call", id: "t1" } },
      }) +
        "\n" +
        acpChunk("ok"),
    );
    expect(deltas(events)).toEqual(["ok"]);
  });
});

describe("plain text parser (devin -p)", () => {
  it("emits each decoded chunk as a delta and concatenates canonically", () => {
    const parser = createPlainTextStreamParser();
    const events = [];
    events.push(...parser.push(enc.encode("Hello ")));
    events.push(...parser.push(enc.encode("世界")));
    events.push(...parser.finish());
    expect(deltas(events)).toEqual(["Hello ", "世界"]);
    expect(completedEvent(events)?.text).toBe("Hello 世界");
  });

  it("survives UTF-8 splits across chunks", () => {
    const parser = createPlainTextStreamParser();
    const bytes = enc.encode("中文");
    const events = [];
    events.push(...parser.push(bytes.subarray(0, 4))); // splits 中
    events.push(...parser.push(bytes.subarray(4)));
    events.push(...parser.finish());
    expect(deltas(events).join("")).toBe("中文");
  });

  it("strips ANSI decoration from deltas", () => {
    const parser = createPlainTextStreamParser();
    const events = feedChunked(
      parser,
      "\x1b[32mgreen\x1b[0m plain",
      1024,
    );
    expect(deltas(events).join("")).toBe("green plain");
  });
});

describe("normalized event model", () => {
  it("exposes the stable abort code", () => {
    expect(STREAM_ABORTED_CODE).toBe("ABORTED");
  });
});

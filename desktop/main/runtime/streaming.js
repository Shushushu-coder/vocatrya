// Streaming validation layer — provider-neutral machinery for consuming
// incremental assistant text out of the managed one-shot runtimes.
//
// Every vendor stream is normalized into the internal event model:
//   { type: "text-delta", delta: string }  — ordered assistant content
//   { type: "completed", text?: string }   — vendor terminal event (text
//                                            is the canonical final answer
//                                            when the protocol carries one)
//   { type: "error", code: string }        — stable failure classification
//
// Nothing here spawns processes or knows about connections — adapters wire
// a parser to the locked-down streaming invocation; connection-service
// drives it through RuntimeCommandRunner's stdout observer.
//
// Rules enforced by these helpers:
// - NDJSON is decoded through an incremental UTF-8 StringDecoder and a
//   line buffer — one stdout chunk is never assumed to be one event, and a
//   multi-byte sequence split across chunks is never corrupted.
// - Malformed or unknown vendor lines are counted and ignored — they never
//   emit content and never leak raw prompt/output into events.
// - Cumulative-snapshot transports (opencode part.text, codex item text)
//   are diffed only while each snapshot is a strict prefix-extension of
//   the previous one; a rewrite is STREAM_COMPLETION_INCONSISTENT, never a
//   guessed diff.
const { StringDecoder } = require("node:string_decoder");

const STREAM_FAILURE_CODES = Object.freeze({
  // No consumable assistant-text delta was ever observed.
  NO_REAL_TEXT_DELTA: "NO_REAL_TEXT_DELTA",
  // The runtime has no usable streaming mechanism.
  STREAM_PROTOCOL_UNSUPPORTED: "STREAM_PROTOCOL_UNSUPPORTED",
  // The vendor stream could not be parsed into the event model.
  STREAM_PROTOCOL_PARSE_FAILED: "STREAM_PROTOCOL_PARSE_FAILED",
  // The runtime did not terminate on abort.
  STREAM_ABORT_FAILED: "STREAM_ABORT_FAILED",
  // Delta reconstruction disagreed with the canonical final text.
  STREAM_COMPLETION_INCONSISTENT: "STREAM_COMPLETION_INCONSISTENT",
  // The vendor stream itself reported an error event.
  STREAM_VENDOR_ERROR: "STREAM_VENDOR_ERROR",
});

// Terminal state for an aborted run — deliberately NOT the generic
// AI_EXECUTION_FAILED bucket so callers can distinguish a cancellation.
const STREAM_ABORTED_CODE = "ABORTED";

function textDelta(delta) {
  return { type: "text-delta", delta };
}
function completed(text) {
  const event = { type: "completed" };
  if (typeof text === "string") event.text = text;
  return event;
}
function errorEvent(code) {
  return { type: "error", code };
}

const ANSI_PATTERN = new RegExp(
  [
    "\\x1b\\[[0-9;?]*[A-Za-z]",
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
    "\\x1b\\([0-9A-Z]",
    "\\x1b.",
  ].join("|"),
  "g",
);

// ---------------------------------------------------------------------------
// Incremental NDJSON parser. mapEvent(parsed) → event | event[] | null; a
// null return marks the line ignored (progress/usage/system noise). The
// parser owns the UTF-8 decoder + line buffer and per-line statistics.
// finishEvent() produces the terminal completed event when the protocol
// did not already emit one.
// ---------------------------------------------------------------------------
function createNdjsonStreamParser({ mapEvent, finishEvent }) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let vendorEventCount = 0;
  let malformedLineCount = 0;
  let ignoredLineCount = 0;
  let finished = false;

  function handleLine(rawLine) {
    const line = rawLine.trim();
    if (!line) return [];
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A non-JSON line is noise, not content — counted, never emitted.
      malformedLineCount += 1;
      return [];
    }
    vendorEventCount += 1;
    const mapped = mapEvent(parsed);
    if (!mapped) {
      ignoredLineCount += 1;
      return [];
    }
    return Array.isArray(mapped) ? mapped : [mapped];
  }

  return {
    push(chunk) {
      if (finished) return [];
      // Buffer/TypedArray chunks decode incrementally; anything else is a
      // string already. (typeof, not instanceof — test realms differ.)
      buffer +=
        typeof chunk === "string" ? chunk : decoder.write(chunk);
      const events = [];
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        events.push(...handleLine(line));
      }
      return events;
    },
    // Flushes the decoder + any trailing unterminated line, then emits the
    // parser's terminal completed event (when the protocol didn't already).
    finish() {
      if (finished) return [];
      finished = true;
      buffer += decoder.end();
      const events = [];
      if (buffer.trim()) events.push(...handleLine(buffer));
      buffer = "";
      const terminal =
        typeof finishEvent === "function" ? finishEvent() : completed();
      if (terminal) events.push(terminal);
      return events;
    },
    stats() {
      return { vendorEventCount, malformedLineCount, ignoredLineCount };
    },
  };
}

// Prefix-extension differ for cumulative-snapshot transports. Returns
// {delta} while every snapshot strictly extends the previous one; a
// rewrite/shrink yields {inconsistent:true} — never a guessed diff.
function createCumulativeDiffer() {
  let snapshot = "";
  let inconsistent = false;
  return {
    push(next) {
      if (typeof next !== "string" || inconsistent) {
        return { inconsistent: true };
      }
      if (!next.startsWith(snapshot)) {
        inconsistent = true;
        return { inconsistent: true };
      }
      const delta = next.slice(snapshot.length);
      snapshot = next;
      return { delta };
    },
    snapshot() {
      return snapshot;
    },
    isInconsistent() {
      return inconsistent;
    },
  };
}

// ---------------------------------------------------------------------------
// Plain-stdout parser (devin -p): the transport carries raw assistant text
// — every decoded chunk that survives ANSI-stripping is a text-delta. The
// canonical answer is the delta concatenation itself; there is no separate
// vendor envelope.
// ---------------------------------------------------------------------------
function createPlainTextStreamParser() {
  const decoder = new StringDecoder("utf8");
  let accumulated = "";
  let finished = false;
  return {
    push(chunk) {
      if (finished) return [];
      const text =
        typeof chunk === "string" ? chunk : decoder.write(chunk);
      const clean = text.replace(ANSI_PATTERN, "");
      if (!clean) return [];
      accumulated += clean;
      return [textDelta(clean)];
    },
    finish() {
      if (finished) return [];
      finished = true;
      const tail = decoder.end().replace(ANSI_PATTERN, "");
      const events = [];
      if (tail) {
        accumulated += tail;
        events.push(textDelta(tail));
      }
      events.push(completed(accumulated));
      return events;
    },
    stats() {
      return {
        vendorEventCount: 0,
        malformedLineCount: 0,
        ignoredLineCount: 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Vendor event mappers. Each maps one parsed NDJSON event to normalized
// events (or null to ignore). State is carried in closures so a mapper is
// single-use per run.
// ---------------------------------------------------------------------------

// OpenCode `run --format json`: {type:"text", part:{id, text}} carries a
// CUMULATIVE part snapshot per part id — prefix-diffed into deltas.
// step_start/step_finish/tool events are progress, never content.
function createOpencodeEventMapper() {
  const differs = new Map(); // partId -> differ
  const partOrder = [];
  let inconsistent = false;
  let sawError = false;

  function canonicalText() {
    return partOrder.map((id) => differs.get(id).snapshot()).join("");
  }

  return {
    mapEvent(event) {
      if (!event || typeof event !== "object") return null;
      if (event.type === "error" || event.is_error === true) {
        sawError = true;
        return errorEvent(STREAM_FAILURE_CODES.STREAM_VENDOR_ERROR);
      }
      if (
        event.type === "text" &&
        event.part &&
        event.part.type === "text"
      ) {
        const id = typeof event.part.id === "string" ? event.part.id : "";
        const text = event.part.text;
        if (typeof text !== "string") return null;
        if (!differs.has(id)) {
          differs.set(id, createCumulativeDiffer());
          partOrder.push(id);
        }
        const diff = differs.get(id).push(text);
        if (diff.inconsistent) {
          inconsistent = true;
          return errorEvent(
            STREAM_FAILURE_CODES.STREAM_COMPLETION_INCONSISTENT,
          );
        }
        return diff.delta ? [textDelta(diff.delta)] : [];
      }
      return null;
    },
    finishEvent() {
      if (inconsistent || sawError) return null;
      return completed(canonicalText());
    },
  };
}

// Anthropic Messages / Claude stream-json shape — covers
// `claude -p --output-format stream-json --verbose --include-partial-messages`
// and `grok -p --output-format streaming-messages-json
// --include-partial-messages`. Recognizes:
//   stream_event{event:{content_block_delta|message_stop}}
//   bare content_block_delta / message_stop (unwrapped Anthropic wire)
//   assistant{message:{id, content:[{type:"text", text}]}} snapshots
//   result{result, is_error} terminal envelope
// Assistant snapshots are only diffed when no delta events were seen for
// the run — snapshot and delta channels carry the same text and must
// never double-count.
function createAnthropicEventMapper() {
  const messageDiffers = new Map(); // message id -> differ
  const messageOrder = [];
  let sawDeltas = false;
  let deltaText = "";
  let resultText = null;
  let sawCompleted = false;
  let sawError = false;
  let inconsistent = false;

  function extractDeltaText(inner) {
    const delta = inner?.delta;
    if (!delta || typeof delta !== "object") return null;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return delta.text;
    }
    return null;
  }

  function mapAssistantMessage(message) {
    if (!message || typeof message !== "object") return null;
    const id = typeof message.id === "string" ? message.id : "";
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((block) => block && block.type === "text")
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("");
    if (sawDeltas) return null; // the delta channel already covered it
    if (!messageDiffers.has(id)) {
      messageDiffers.set(id, createCumulativeDiffer());
      messageOrder.push(id);
    }
    const diff = messageDiffers.get(id).push(text);
    if (diff.inconsistent) {
      inconsistent = true;
      return errorEvent(STREAM_FAILURE_CODES.STREAM_COMPLETION_INCONSISTENT);
    }
    return diff.delta ? [textDelta(diff.delta)] : [];
  }

  function canonicalText() {
    if (typeof resultText === "string") return resultText;
    if (sawDeltas) return deltaText;
    return messageOrder.map((id) => messageDiffers.get(id).snapshot()).join("");
  }

  return {
    mapEvent(event) {
      if (!event || typeof event !== "object") return null;
      if (event.is_error === true || event.type === "error") {
        sawError = true;
        return errorEvent(STREAM_FAILURE_CODES.STREAM_VENDOR_ERROR);
      }
      if (event.type === "assistant") {
        return mapAssistantMessage(event.message);
      }
      if (event.type === "result") {
        if (typeof event.result === "string") resultText = event.result;
        sawCompleted = true;
        return completed(canonicalText());
      }
      // Unwrap the stream_event envelope when present.
      const inner =
        event.type === "stream_event" &&
        event.event &&
        typeof event.event === "object"
          ? event.event
          : event;
      if (inner.type === "content_block_delta") {
        const text = extractDeltaText(inner);
        if (text == null) return null;
        sawDeltas = true;
        deltaText += text;
        return text ? [textDelta(text)] : [];
      }
      if (inner.type === "message_stop") {
        sawCompleted = true;
        return completed(canonicalText());
      }
      return null;
    },
    finishEvent() {
      if (inconsistent || sawError) return null;
      if (sawCompleted) return null;
      return completed(canonicalText());
    },
  };
}

// ACP `session/update` NDJSON (cursor-agent streaming-json; the generic
// Agent Client Protocol notification channel). Only agent_message_chunk
// text content is assistant text — thought chunks, tool calls, plans and
// usage are never content.
function createAcpEventMapper() {
  let deltaText = "";
  let sawError = false;
  return {
    mapEvent(frame) {
      if (!frame || typeof frame !== "object") return null;
      const isSessionUpdate =
        frame.method === "session/update" ||
        frame.type === "session_update" ||
        frame.type === "sessionUpdate";
      const update = frame.params?.update || frame.update || null;
      if (!isSessionUpdate) {
        // Other JSON-RPC traffic (responses, requests) is never content.
        return null;
      }
      const kind = update?.sessionUpdate || update?.type;
      if (kind === "agent_message_chunk") {
        const content = update.content;
        const text =
          typeof content?.text === "string"
            ? content.text
            : typeof update.text === "string"
              ? update.text
              : null;
        if (text == null) return null;
        deltaText += text;
        return text ? [textDelta(text)] : [];
      }
      if (kind === "error" || frame.error) {
        sawError = true;
        return errorEvent(STREAM_FAILURE_CODES.STREAM_VENDOR_ERROR);
      }
      return null;
    },
    finishEvent() {
      if (sawError) return null;
      return completed(deltaText);
    },
  };
}

// Codex `exec --json`: run events carry item snapshots ({type:
// "item.completed"|"item.updated", item:{id, type:"agent_message", text}}).
// text is cumulative per item — prefix-diffed into deltas. A single
// item.completed with the full text is NOT streaming evidence; the verdict
// layer decides via delta/chunk counts.
function createCodexEventMapper() {
  const differs = new Map();
  const itemOrder = [];
  let deltaText = "";
  let sawDeltaChannel = false;
  let inconsistent = false;
  let sawCompleted = false;
  let sawError = false;

  function canonicalText() {
    if (sawDeltaChannel) return deltaText;
    return itemOrder.map((id) => differs.get(id).snapshot()).join("");
  }

  return {
    mapEvent(event) {
      if (!event || typeof event !== "object") return null;
      if (event.type === "error" || event.type === "turn.failed") {
        sawError = true;
        return errorEvent(STREAM_FAILURE_CODES.STREAM_VENDOR_ERROR);
      }
      // Delta-shaped events, if the installed version emits them.
      if (
        /delta/i.test(String(event.type || "")) &&
        /message/i.test(String(event.type || "")) &&
        typeof event.delta === "string"
      ) {
        sawDeltaChannel = true;
        deltaText += event.delta;
        return event.delta ? [textDelta(event.delta)] : [];
      }
      const item = event.item;
      if (
        item &&
        item.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        if (sawDeltaChannel) return null; // delta channel covered it
        const id = typeof item.id === "string" ? item.id : "";
        if (!differs.has(id)) {
          differs.set(id, createCumulativeDiffer());
          itemOrder.push(id);
        }
        const diff = differs.get(id).push(item.text);
        if (diff.inconsistent) {
          inconsistent = true;
          return errorEvent(
            STREAM_FAILURE_CODES.STREAM_COMPLETION_INCONSISTENT,
          );
        }
        return diff.delta ? [textDelta(diff.delta)] : [];
      }
      if (event.type === "turn.completed") {
        sawCompleted = true;
        return completed(canonicalText());
      }
      return null;
    },
    finishEvent() {
      if (inconsistent || sawError) return null;
      if (sawCompleted) return null;
      return completed(canonicalText());
    },
  };
}

// Cursor `agent -p --output-format streaming-json` — the documented shape
// is "one ACP session update per line"; Claude-style envelopes are
// tolerated too. Both mappers share one decoded event stream: an event is
// tried against the ACP mapping first, then the Anthropic mapping.
function createCursorEventMapper() {
  const acp = createAcpEventMapper();
  const anthropic = createAnthropicEventMapper();
  let acpSawContent = false;
  return {
    mapEvent(event) {
      if (!event || typeof event !== "object") return null;
      const isAcpFrame =
        event.method === "session/update" ||
        event.type === "session_update" ||
        event.type === "sessionUpdate" ||
        (event.params && event.params.update);
      if (isAcpFrame) {
        const mapped = acp.mapEvent(event);
        if (
          Array.isArray(mapped)
            ? mapped.some((e) => e.type === "text-delta")
            : mapped?.type === "text-delta"
        ) {
          acpSawContent = true;
        }
        return mapped;
      }
      // Never feed ACP-shaped frames into the Anthropic mapper — and once
      // ACP content has been seen, an unrecognized frame stays ignored.
      if (acpSawContent) return null;
      return anthropic.mapEvent(event);
    },
    finishEvent() {
      if (acpSawContent) return acp.finishEvent();
      return anthropic.finishEvent();
    },
  };
}

// Parser factories — one per vendor mechanism the adapters wire up.
function createOpencodeStreamParser() {
  const mapper = createOpencodeEventMapper();
  return createNdjsonStreamParser({
    mapEvent: mapper.mapEvent,
    finishEvent: mapper.finishEvent,
  });
}
function createAnthropicStreamParser() {
  const mapper = createAnthropicEventMapper();
  return createNdjsonStreamParser({
    mapEvent: mapper.mapEvent,
    finishEvent: mapper.finishEvent,
  });
}
function createAcpStreamParser() {
  const mapper = createAcpEventMapper();
  return createNdjsonStreamParser({
    mapEvent: mapper.mapEvent,
    finishEvent: mapper.finishEvent,
  });
}
function createCodexStreamParser() {
  const mapper = createCodexEventMapper();
  return createNdjsonStreamParser({
    mapEvent: mapper.mapEvent,
    finishEvent: mapper.finishEvent,
  });
}
function createCursorStreamParser() {
  const mapper = createCursorEventMapper();
  return createNdjsonStreamParser({
    mapEvent: mapper.mapEvent,
    finishEvent: mapper.finishEvent,
  });
}

module.exports = {
  STREAM_ABORTED_CODE,
  STREAM_FAILURE_CODES,
  createAcpStreamParser,
  createAnthropicStreamParser,
  createCodexStreamParser,
  createCumulativeDiffer,
  createCursorStreamParser,
  createNdjsonStreamParser,
  createOpencodeStreamParser,
  createPlainTextStreamParser,
};

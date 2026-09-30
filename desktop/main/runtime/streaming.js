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
// - Cumulative-snapshot transports (opencode part.text) are diffed only
//   while each snapshot is a strict prefix-extension of the previous one;
//   a rewrite is STREAM_COMPLETION_INCONSISTENT, never a guessed diff.
// - Protocol drivers (codex app-server JSON-RPC) reconcile the delta
//   channel against each completed item's canonical text; any mismatch is
//   STREAM_COMPLETION_INCONSISTENT.
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

// ---------------------------------------------------------------------------
// codex app-server (stdio JSON-RPC) — the verified incremental mechanism
// on codex-cli 0.154.0. `codex exec --json` was probed and is NOT a real
// stream (one terminal item.completed snapshot); `codex app-server
// --listen stdio://` emits real `item/agentMessage/delta` notifications —
// model deltas on separate stdout deliveries — before `turn/completed`.
//
// This parser is a stateful protocol driver, not just a line mapper:
// attachStdin() hands it the child's stdin so it can issue the handshake
// (initialize → initialized → thread/start → turn/start) and advance it
// as each response arrives. Closing stdin after the terminal notification
// shuts the server down cleanly.
//
// Reconciliation is per-item: concat(deltas[itemId]) must equal that
// agentMessage item's completed text or the run fails
// STREAM_COMPLETION_INCONSISTENT — never ship mismatched text. A stream
// that ends without turn/completed is a protocol failure, never a
// truncated answer passed off as complete.
// ---------------------------------------------------------------------------
function createCodexStreamParser({ prompt, model, workingDirectory } = {}) {
  const decoder = new StringDecoder("utf8");
  let lineBuf = "";
  let malformedLineCount = 0;
  let ignoredLineCount = 0;

  // Events produced by mid-push state transitions (handshake steps,
  // terminal events) queue here and drain through the push()/finish()
  // return value — the driver never calls out asynchronously.
  const pendingEvents = [];
  const queueEvent = (event) => pendingEvents.push(event);
  const drain = () => pendingEvents.splice(0, pendingEvents.length);

  let stdin = null;
  let nextRequestId = 1;
  // In-flight requests by id — only the handshake methods are ever issued;
  // anything else on the wire carrying an id is a server→client request
  // and is declined (TEXT_ONLY never grants a channel back into the host).
  const pendingRequests = new Map();
  let terminalEmitted = false;
  let vendorFailure = false;
  let driverFailed = false;

  // itemId → concatenated delta text / completed text — the strict
  // per-item reconciliation pair.
  const deltasByItem = new Map();
  const completedByItem = new Map();
  // First-delta arrival order — canonical ordering if a turn ever yields
  // more than one agentMessage item.
  const itemOrder = [];

  const endStdin = () => {
    try {
      stdin?.end();
    } catch {
      /* pipe already gone */
    }
  };

  const sendMessage = (message) => {
    if (!stdin || terminalEmitted) return;
    try {
      stdin.write(JSON.stringify(message) + "\n");
    } catch {
      driverFailed = true;
      endStdin();
    }
  };

  const sendRequest = (method, params) => {
    const id = nextRequestId++;
    pendingRequests.set(id, method);
    sendMessage({ method, id, params });
  };

  const emitTerminalError = (code) => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    endStdin();
    queueEvent({ type: "error", code });
  };

  const emitCompleted = () => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    endStdin();
    // Per-item reconciliation: every completed agentMessage must equal
    // its own delta channel exactly — a partial match means the wire was
    // not faithful and nothing may ship as the answer.
    let canonical = "";
    for (const itemId of itemOrder) {
      const completedText = completedByItem.get(itemId);
      if (completedText === undefined) {
        canonical += deltasByItem.get(itemId) ?? "";
        continue;
      }
      if ((deltasByItem.get(itemId) ?? "") !== completedText) {
        queueEvent({
          type: "error",
          code: STREAM_FAILURE_CODES.STREAM_COMPLETION_INCONSISTENT,
        });
        return;
      }
      canonical += completedText;
    }
    // An agentMessage item that completed without a single delta carries
    // no incremental prefix — it still belongs to the answer.
    for (const [itemId, text] of completedByItem) {
      if (!itemOrder.includes(itemId)) canonical += text;
    }
    queueEvent(completed(canonical));
  };

  const handleResponse = (msg) => {
    const method = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    if (msg.error !== undefined) {
      vendorFailure = true;
      emitTerminalError(STREAM_FAILURE_CODES.STREAM_VENDOR_ERROR);
      return;
    }
    switch (method) {
      case "initialize":
        sendMessage({ method: "initialized" });
        sendRequest("thread/start", {
          cwd: workingDirectory,
          model: model ?? null,
          // Never let the provider silently substitute a model — the
          // business layer pinned this exact model id.
          allowProviderModelFallback: false,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
        });
        break;
      case "thread/start": {
        const threadId = msg.result?.thread?.id;
        if (typeof threadId !== "string" || !threadId) {
          emitTerminalError(STREAM_FAILURE_CODES.STREAM_PROTOCOL_PARSE_FAILED);
          return;
        }
        sendRequest("turn/start", {
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          model: model ?? null,
        });
        break;
      }
      default:
        // turn/start — live; deltas arrive as notifications from here.
        break;
    }
  };

  const handleNotification = (msg) => {
    const params = msg.params ?? {};
    switch (msg.method) {
      case "item/agentMessage/delta": {
        const { itemId, delta } = params;
        if (typeof itemId !== "string" || typeof delta !== "string") {
          malformedLineCount += 1;
          return;
        }
        if (!deltasByItem.has(itemId)) itemOrder.push(itemId);
        deltasByItem.set(itemId, (deltasByItem.get(itemId) ?? "") + delta);
        if (delta) queueEvent(textDelta(delta));
        return;
      }
      case "item/completed": {
        const item = params.item;
        if (item && item.type === "agentMessage") {
          completedByItem.set(
            item.id,
            typeof item.text === "string" ? item.text : "",
          );
        }
        return;
      }
      case "turn/started":
        return;
      case "turn/completed": {
        const status = params.turn?.status;
        if (status === "completed") {
          emitCompleted();
        } else {
          // Vocatrya aborts by terminating the child — an interrupted or
          // failed turn we did not ask for is a vendor-side failure.
          vendorFailure = true;
          emitTerminalError(STREAM_FAILURE_CODES.STREAM_VENDOR_ERROR);
        }
        return;
      }
      case "error":
        // willRetry:true marks transport-layer reconnects (the ChatGPT
        // backend falls back from WebSocket to HTTPS across retried
        // requests) — diagnostics, not terminal failures. Non-retry
        // errors are recorded; turn/completed stays the terminal driver.
        if (params.willRetry === true) return;
        vendorFailure = true;
        return;
      default:
        // Diagnostics (thread/status, reasoning deltas, rawResponseItem,
        // warnings, …) never become content.
        ignoredLineCount += 1;
        return;
    }
  };

  const handleLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // A non-JSON line is noise, not content — counted, never emitted.
      malformedLineCount += 1;
      return;
    }
    if (!msg || typeof msg !== "object") {
      malformedLineCount += 1;
      return;
    }
    if (
      msg.id !== undefined &&
      (msg.result !== undefined || msg.error !== undefined)
    ) {
      handleResponse(msg);
      return;
    }
    if (msg.id !== undefined && typeof msg.method === "string") {
      sendMessage({
        id: msg.id,
        error: { code: -32601, message: "unsupported" },
      });
      return;
    }
    if (typeof msg.method === "string") {
      handleNotification(msg);
      return;
    }
    ignoredLineCount += 1;
  };

  return {
    // Hands the driver the child's stdin; the handshake starts here.
    attachStdin(stream) {
      stdin = stream;
      sendRequest("initialize", {
        clientInfo: { name: "vocatrya", title: null, version: "0.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
    },
    push(chunk) {
      lineBuf +=
        typeof chunk === "string" ? chunk : decoder.write(chunk);
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        handleLine(line);
      }
      return drain();
    },
    finish() {
      lineBuf += decoder.end();
      if (lineBuf.trim()) handleLine(lineBuf);
      lineBuf = "";
      if (!terminalEmitted) {
        // Ended before turn/completed — a driver write failure, a vendor
        // error with no terminal, or a server that went silent mid-turn.
        // Partial deltas are never shipped as a completed answer.
        terminalEmitted = true;
        queueEvent({
          type: "error",
          code: vendorFailure || driverFailed
            ? STREAM_FAILURE_CODES.STREAM_VENDOR_ERROR
            : STREAM_FAILURE_CODES.STREAM_PROTOCOL_PARSE_FAILED,
        });
      }
      return drain();
    },
    stats() {
      return { malformedLineCount, ignoredLineCount };
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
// createCodexStreamParser is defined with the app-server driver above —
// its signature ({prompt, model, workingDirectory}) carries the turn the
// JSON-RPC handshake must start.
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

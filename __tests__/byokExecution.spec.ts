// @vitest-environment node
/**
 * BYOK execution seam — the LOCAL_BYOK branch of executeAIConnectionText.
 *
 * What this spec proves with synthetic data and stubbed AI SDK calls:
 * - one-shot resolves the bound ApiKey row strictly (id + userId +
 *   provider), decrypts in place, and reports PROMPT_AND_VALIDATE
 * - a missing, foreign, or undecryptable credential fails
 *   BYOK_CREDENTIAL_UNAVAILABLE — env vars are never consulted
 * - provider/network/quota-shaped failures collapse to AI_EXECUTION_FAILED,
 *   timeouts to AI_EXECUTION_TIMEOUT, aborts to AI_EXECUTION_FAILED
 * - the BYOK connection never touches the desktop channel: no exec URL,
 *   no ticket, no runtime profile — path isolation from ACCOUNT_LOGIN
 * - streaming yields real provider deltas then a completed terminal event
 */
import {
  executeByokConnectionText,
  executeByokConnectionTextStream,
} from "@/lib/ai/byok-execution";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { AI_BUSINESS_ERROR_CODES } from "@/lib/ai/connections";

const KEY_ID = "9b2d1c2a-0000-4000-8000-000000000001";
const USER = "user-1";

// Credential-store isolation: an explicit empty env makes every credential
// lookup ignore ambient VOCATRYA_CREDENTIAL_URL / _TOKEN — and the fetch
// stub proves the spec never reaches a real desktop broker.
const NO_BROKER = { env: {}, fetchImpl: vi.fn() } as const;

// Env keys this spec mutates; afterEach restores the caller's original
// values instead of deleting whatever the environment already had.
const SPEC_ENV_KEYS = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = Object.fromEntries(
  SPEC_ENV_KEYS.map((key) => [key, process.env[key]]),
);
function restoreSpecEnv() {
  for (const key of SPEC_ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

function byokConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-byok",
    userId: USER,
    provider: "DEEPSEEK",
    backendKind: "LOCAL_BYOK",
    authType: "API_KEY",
    credentialRef: KEY_ID,
    runtimeProfileRef: null,
    accountIdentity: null,
    status: "CONNECTED",
    archivedAt: null,
    ...overrides,
  };
}

function dbWithKey(row: { encryptedKey: string; iv: string } | null) {
  const findFirst = vi.fn(async (args: { where: Record<string, unknown> }) => {
    // Mirror the real query: a row only matches the exact binding triple.
    const w = args.where;
    if (
      row &&
      w.id === KEY_ID &&
      w.userId === USER &&
      w.provider === "deepseek"
    ) {
      return { id: KEY_ID, ...row };
    }
    return null;
  });
  return {
    apiKey: {
      findFirst,
      update: vi.fn(async () => ({})),
    },
  };
}

const PLAINTEXT_ROW = { encryptedKey: "sk-synthetic-key", iv: "" };

describe("executeByokConnectionText — credential boundary", () => {
  afterEach(restoreSpecEnv);

  it("runs the bound key through the provider factory and returns the text", async () => {
    const generate = vi.fn(
      async (_args: { model: unknown; prompt: string; abortSignal: AbortSignal }) => ({
        text: "synthetic reply",
        finishReason: "stop",
      }),
    );
    const db = dbWithKey(PLAINTEXT_ROW);
    const result = await executeByokConnectionText(
      {
        userId: USER,
        connection: byokConnection(),
        model: "deepseek-chat",
        prompt: "ping",
      },
      { dbClient: db as never, generateTextImpl: generate as never },
    );
    expect(result.text).toBe("synthetic reply");
    expect(result.structuredStrategy).toBe("PROMPT_AND_VALIDATE");
    expect(result.stopReason).toBe("stop");
    expect(generate).toHaveBeenCalledTimes(1);
    const call = generate.mock.calls[0][0];
    expect(call.prompt).toBe("ping");
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("fails BYOK_CREDENTIAL_UNAVAILABLE when nothing is bound — even with an env key present", async () => {
    process.env.DEEPSEEK_API_KEY = "env-key-that-must-not-be-used";
    const generate = vi.fn();
    await expect(
      executeByokConnectionText(
        {
          userId: USER,
          connection: byokConnection({ credentialRef: null }),
          model: "deepseek-chat",
          prompt: "ping",
        },
        { dbClient: dbWithKey(PLAINTEXT_ROW) as never, generateTextImpl: generate as never },
      ),
    ).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.BYOK_CREDENTIAL_UNAVAILABLE });
    expect(generate).not.toHaveBeenCalled();
  });

  it("fails BYOK_CREDENTIAL_UNAVAILABLE when the bound row is gone — no env fallback", async () => {
    process.env.DEEPSEEK_API_KEY = "env-key-that-must-not-be-used";
    const generate = vi.fn();
    await expect(
      executeByokConnectionText(
        {
          userId: USER,
          connection: byokConnection(),
          model: "deepseek-chat",
          prompt: "ping",
        },
        { dbClient: dbWithKey(null) as never, generateTextImpl: generate as never },
      ),
    ).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.BYOK_CREDENTIAL_UNAVAILABLE });
    expect(generate).not.toHaveBeenCalled();
  });

  it("fails BYOK_CREDENTIAL_UNAVAILABLE on an undecryptable os-envelope row (no broker)", async () => {
    // Explicit empty env — the row can only resolve through a broker that
    // is not configured here, regardless of ambient desktop env values.
    const generate = vi.fn();
    await expect(
      executeByokConnectionText(
        {
          userId: USER,
          connection: byokConnection(),
          model: "deepseek-chat",
          prompt: "ping",
        },
        {
          dbClient: dbWithKey({ encryptedKey: "aGVsbG8=", iv: "os:v1" }) as never,
          credentialStore: NO_BROKER as never,
          generateTextImpl: generate as never,
        },
      ),
    ).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.BYOK_CREDENTIAL_UNAVAILABLE });
    expect(generate).not.toHaveBeenCalled();
    expect(NO_BROKER.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a provider with no BYOK execution surface before touching credentials", async () => {
    const db = dbWithKey(PLAINTEXT_ROW);
    const generate = vi.fn();
    await expect(
      executeByokConnectionText(
        {
          userId: USER,
          connection: byokConnection({ provider: "ANTHROPIC" }),
          model: "claude-x",
          prompt: "ping",
        },
        { dbClient: db as never, generateTextImpl: generate as never },
      ),
    ).rejects.toMatchObject({
      code: AI_BUSINESS_ERROR_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION,
    });
    expect(db.apiKey.findFirst).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("executeByokConnectionText — error taxonomy", () => {
  function rejectsWith(error: unknown) {
    return vi.fn(async () => {
      throw error;
    });
  }

  it("maps a provider/network/quota failure to AI_EXECUTION_FAILED without leaking detail", async () => {
    for (const failure of [
      new Error("HTTP 401 Unauthorized"),
      new Error("HTTP 402 insufficient balance"),
      new Error("HTTP 404 model not found"),
      new Error("fetch failed ECONNREFUSED"),
      new Error("HTTP 429 rate limit"),
    ]) {
      await expect(
        executeByokConnectionText(
          {
            userId: USER,
            connection: byokConnection(),
            model: "deepseek-chat",
            prompt: "ping",
          },
          {
            dbClient: dbWithKey(PLAINTEXT_ROW) as never,
            generateTextImpl: rejectsWith(failure) as never,
          },
        ),
      ).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED });
    }
  });

  it("maps an SDK-thrown TimeoutError to AI_EXECUTION_TIMEOUT", async () => {
    // Provider-side timeout naming, not the seam's own deadline — the real
    // deadline regression is covered by the timeoutMs test below.
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    await expect(
      executeByokConnectionText(
        {
          userId: USER,
          connection: byokConnection(),
          model: "deepseek-chat",
          prompt: "ping",
        },
        {
          dbClient: dbWithKey(PLAINTEXT_ROW) as never,
          generateTextImpl: rejectsWith(timeout) as never,
        },
      ),
    ).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_TIMEOUT });
  });

  it("classifies a REAL deadline expiry as AI_EXECUTION_TIMEOUT, not a generic abort", async () => {
    // Regression: the combined signal aborts with a TimeoutError reason at
    // timeoutMs; previously signal.aborted won the ordering and this read
    // as AI_EXECUTION_FAILED. The impl honours the seam's own abortSignal
    // the way the AI SDK would — it does not fake the failure.
    const generate = vi.fn(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          if (abortSignal.aborted) reject(abortSignal.reason);
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        }),
    );
    await expect(
      executeByokConnectionText(
        {
          userId: USER,
          connection: byokConnection(),
          model: "deepseek-chat",
          prompt: "ping",
          timeoutMs: 1_000, // the seam clamps to >= 1s
        },
        {
          dbClient: dbWithKey(PLAINTEXT_ROW) as never,
          credentialStore: NO_BROKER as never,
          generateTextImpl: generate as never,
        },
      ),
    ).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_TIMEOUT });
  }, 15_000);

  it("classifies a caller-initiated abort as AI_EXECUTION_FAILED", async () => {
    const controller = new AbortController();
    const generate = vi.fn(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
          setTimeout(() => controller.abort(), 10);
        }),
    );
    await expect(
      executeByokConnectionText(
        {
          userId: USER,
          connection: byokConnection(),
          model: "deepseek-chat",
          prompt: "ping",
          signal: controller.signal,
        },
        {
          dbClient: dbWithKey(PLAINTEXT_ROW) as never,
          credentialStore: NO_BROKER as never,
          generateTextImpl: generate as never,
        },
      ),
    ).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED });
  });

  it("maps a pre-aborted caller signal rejection to AI_EXECUTION_FAILED", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(
      executeByokConnectionText(
        {
          userId: USER,
          connection: byokConnection(),
          model: "deepseek-chat",
          prompt: "ping",
        },
        {
          dbClient: dbWithKey(PLAINTEXT_ROW) as never,
          generateTextImpl: rejectsWith(abort) as never,
        },
      ),
    ).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED });
  });
});

describe("executeByokConnectionTextStream", () => {
  function streamOf(deltas: string[]) {
    return {
      textStream: (async function* () {
        for (const d of deltas) yield d;
      })(),
    };
  }

  it("emits real text-delta events then a completed terminal event", async () => {
    const streamText = vi.fn(() => streamOf(["hel", "lo", " world"]));
    const events: Array<Record<string, unknown>> = [];
    for await (const event of executeByokConnectionTextStream(
      {
        userId: USER,
        connection: byokConnection(),
        model: "deepseek-chat",
        prompt: "ping",
      },
      {
        dbClient: dbWithKey(PLAINTEXT_ROW) as never,
        streamTextImpl: streamText as never,
      },
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "text-delta", delta: "hel" },
      { type: "text-delta", delta: "lo" },
      { type: "text-delta", delta: " world" },
      { type: "completed", text: "hello world", model: "deepseek-chat" },
    ]);
  });

  it("maps a mid-stream provider failure to AI_EXECUTION_FAILED", async () => {
    const streamText = vi.fn(() => ({
      textStream: (async function* () {
        yield "partial";
        throw new Error("HTTP 500");
      })(),
    }));
    const seen: string[] = [];
    await expect(async () => {
      for await (const event of executeByokConnectionTextStream(
        {
          userId: USER,
          connection: byokConnection(),
          model: "deepseek-chat",
          prompt: "ping",
        },
        {
          dbClient: dbWithKey(PLAINTEXT_ROW) as never,
          streamTextImpl: streamText as never,
        },
      )) {
        if (event.type === "text-delta") seen.push(event.delta);
      }
    }).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED });
    expect(seen).toEqual(["partial"]);
  });

  it("classifies a REAL deadline expiry mid-stream as AI_EXECUTION_TIMEOUT", async () => {
    const streamText = vi.fn(({ abortSignal }: { abortSignal: AbortSignal }) => ({
      textStream: (async function* () {
        yield "partial";
        await new Promise<never>((_resolve, reject) => {
          if (abortSignal.aborted) reject(abortSignal.reason);
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        });
      })(),
    }));
    const seen: string[] = [];
    await expect(async () => {
      for await (const event of executeByokConnectionTextStream(
        {
          userId: USER,
          connection: byokConnection(),
          model: "deepseek-chat",
          prompt: "ping",
          timeoutMs: 1_000,
        },
        {
          dbClient: dbWithKey(PLAINTEXT_ROW) as never,
          credentialStore: NO_BROKER as never,
          streamTextImpl: streamText as never,
        },
      )) {
        if (event.type === "text-delta") seen.push(event.delta);
      }
    }).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_TIMEOUT });
    expect(seen).toEqual(["partial"]);
  }, 15_000);

  it("classifies a caller-initiated abort mid-stream as AI_EXECUTION_FAILED", async () => {
    const controller = new AbortController();
    const streamText = vi.fn(({ abortSignal }: { abortSignal: AbortSignal }) => ({
      textStream: (async function* () {
        yield "partial";
        await new Promise<never>((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
          setTimeout(() => controller.abort(), 10);
        });
      })(),
    }));
    await expect(async () => {
      for await (const _event of executeByokConnectionTextStream(
        {
          userId: USER,
          connection: byokConnection(),
          model: "deepseek-chat",
          prompt: "ping",
          signal: controller.signal,
        },
        {
          dbClient: dbWithKey(PLAINTEXT_ROW) as never,
          credentialStore: NO_BROKER as never,
          streamTextImpl: streamText as never,
        },
      )) {
        void _event;
      }
    }).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED });
  });

  it("fails BYOK_CREDENTIAL_UNAVAILABLE before opening a stream when the key is unreadable", async () => {
    const streamText = vi.fn();
    await expect(async () => {
      for await (const _event of executeByokConnectionTextStream(
        {
          userId: USER,
          connection: byokConnection(),
          model: "deepseek-chat",
          prompt: "ping",
        },
        {
          dbClient: dbWithKey(null) as never,
          streamTextImpl: streamText as never,
        },
      )) {
        void _event;
      }
    }).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.BYOK_CREDENTIAL_UNAVAILABLE });
    expect(streamText).not.toHaveBeenCalled();
  });
});

describe("executeAIConnectionText — BYOK dispatch isolation", () => {
  function dispatchDb(connection: Record<string, unknown>, keyRow: { encryptedKey: string; iv: string } | null) {
    return {
      aIConnection: {
        findFirst: vi.fn(async () => connection),
      },
      apiKey: {
        findFirst: vi.fn(async () =>
          keyRow ? { id: KEY_ID, ...keyRow } : null,
        ),
        update: vi.fn(async () => ({})),
      },
    };
  }

  it("executes in-process without the desktop channel — no ticket, no runtime", async () => {
    // The BYOK branch never reads VOCATRYA_DESKTOP_EXEC_URL/_TOKEN — this
    // spec neither sets nor clears them. A LOCAL_BYOK connection runs to
    // completion entirely in-process; an ACCOUNT_LOGIN connection would
    // need the injected channel and fail RUNTIME_NOT_AVAILABLE without it.
    const generate = vi.fn(async () => ({ text: "ok", finishReason: "stop" }));
    const result = await executeAIConnectionText(
      {
        userId: USER,
        connectionId: "conn-byok",
        model: "deepseek-chat",
        prompt: "ping",
      },
      {
        dbClient: dispatchDb(byokConnection(), PLAINTEXT_ROW) as never,
        generateTextImpl: generate as never,
      },
    );
    expect(result.text).toBe("ok");
    expect(result.backendKind).toBe("LOCAL_BYOK");
    expect(result.provider).toBe("DEEPSEEK");
    expect(result.structuredStrategy).toBe("PROMPT_AND_VALIDATE");
  });

  it("status-gates a BYOK connection before any credential work", async () => {
    const generate = vi.fn();
    await expect(
      executeAIConnectionText(
        {
          userId: USER,
          connectionId: "conn-byok",
          model: "deepseek-chat",
          prompt: "ping",
        },
        {
          dbClient: dispatchDb(
            byokConnection({ status: "DISCONNECTED" }),
            PLAINTEXT_ROW,
          ) as never,
          generateTextImpl: generate as never,
        },
      ),
    ).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.CONNECTION_DISCONNECTED });
    await expect(
      executeAIConnectionText(
        {
          userId: USER,
          connectionId: "conn-byok",
          model: "deepseek-chat",
          prompt: "ping",
        },
        {
          dbClient: dispatchDb(
            byokConnection({ status: "REAUTH_REQUIRED" }),
            PLAINTEXT_ROW,
          ) as never,
          generateTextImpl: generate as never,
        },
      ),
    ).rejects.toMatchObject({ code: AI_BUSINESS_ERROR_CODES.REAUTH_REQUIRED });
    expect(generate).not.toHaveBeenCalled();
  });

  it("rejects a malformed BYOK identity (runtimeProfileRef present) as INVALID", async () => {
    await expect(
      executeAIConnectionText(
        {
          userId: USER,
          connectionId: "conn-byok",
          model: "deepseek-chat",
          prompt: "ping",
        },
        {
          dbClient: dispatchDb(
            byokConnection({ runtimeProfileRef: "rp_11111111-1111-4111-8111-111111111111" }),
            PLAINTEXT_ROW,
          ) as never,
        },
      ),
    ).rejects.toMatchObject({
      code: AI_BUSINESS_ERROR_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION,
    });
  });
});

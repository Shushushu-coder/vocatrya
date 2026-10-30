import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import { PROVIDER_VERIFIERS } from "@/lib/ai/provider-registry.server";

// Each verifier's fetch self-aborts at AI_PROVIDER_FETCH_TIMEOUT_MS; this
// outer bound keeps the HTTP response from leaving "Verify & Save" pending
// forever. Current network verifiers also abort their own fetch sooner.
const VERIFY_TIMEOUT_MS = 20_000;
// Same bound as apiKeySaveSchema — the value being verified is the value
// about to be saved.
const MAX_KEY_CHARS = 4_096;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Not authenticated" }, { status: 401 });
  }

  let body: { provider?: unknown; key?: unknown };
  try {
    body = (await req.json()) as { provider?: unknown; key?: unknown };
  } catch {
    return NextResponse.json(
      { success: false, error: "Provider and key are required" },
      { status: 400 },
    );
  }

  const provider = typeof body?.provider === "string" ? body.provider : "";
  // Copied keys routinely pick up surrounding whitespace/newlines — the
  // value verified must be exactly the value stored.
  const key = typeof body?.key === "string" ? body.key.trim() : "";

  if (!provider || !key) {
    return NextResponse.json(
      { success: false, error: "Provider and key are required" },
      { status: 400 },
    );
  }
  if (key.length > MAX_KEY_CHARS) {
    return NextResponse.json(
      { success: false, error: "API key is too long" },
      { status: 400 },
    );
  }

  const verifier = PROVIDER_VERIFIERS[provider];
  if (!verifier) {
    return NextResponse.json(
      { success: false, error: "Unknown provider" },
      { status: 400 },
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      verifier(key),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("VERIFY_TIMEOUT")),
          VERIFY_TIMEOUT_MS,
        );
      }),
    ]);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Verification failed";
    // The verifier's own fetch abort surfaces as a TimeoutError; the outer
    // race rejects with VERIFY_TIMEOUT. Both mean "provider did not
    // answer" — report them identically.
    const timedOut =
      message === "VERIFY_TIMEOUT" ||
      (error instanceof Error && error.name === "TimeoutError");
    return NextResponse.json({
      success: false,
      error: timedOut
        ? `${provider} did not respond in time. Check your network and try again`
        : message.includes("fetch failed") || message.includes("ECONNREFUSED")
          ? `Cannot connect to ${provider} service`
          : "Verification failed. Check the key and try again",
    });
  } finally {
    clearTimeout(timer);
  }
}

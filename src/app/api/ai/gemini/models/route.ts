import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/api-key-resolver";
import { APP_CONSTANTS } from "@/lib/constants";
import { log } from "@/lib/telemetry";

export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    const apiKey = await resolveApiKey(userId, "gemini");

    if (!apiKey) {
      return NextResponse.json(
        { error: "Gemini API key not configured" },
        { status: 500 }
      );
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      {
        signal: AbortSignal.timeout(APP_CONSTANTS.AI_PROVIDER_FETCH_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to fetch Gemini models" },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    log.error("Error fetching models", {
      provider: "gemini",
      error: String(error),
    });
    return NextResponse.json(
      { error: "Failed to fetch Gemini models" },
      { status: 500 }
    );
  }
}

/**
 * Ownership helpers — DI version (IMPORT_REWRITE).
 * Source: InterviewDx vocatrya-port src/services/ownership.ts
 */
import { DomainError } from "../persistence/interviewErrors";
import {
  assertOwnershipView,
  assertWritableView,
  type SessionOwnershipView,
  type UserOwnershipPort,
} from "../hostPorts";

export {
  assertOwnershipView,
  assertWritableView,
  assertSameUserId,
} from "../hostPorts";

function toDomainError(error: unknown, fallbackCode: string): DomainError {
  if (error instanceof DomainError) return error;
  const code = (error as { code?: string } | null)?.code ?? fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  return new DomainError(code, message);
}

export async function loadOwnershipView(
  ownershipPort: UserOwnershipPort,
  userId: string,
  sessionId: string,
): Promise<SessionOwnershipView> {
  try {
    const view = await ownershipPort.loadSessionOwnership(sessionId);
    assertOwnershipView(view, userId);
    return view;
  } catch (error) {
    throw toDomainError(error, "SESSION_FORBIDDEN");
  }
}

export async function loadWritableOwnership(
  ownershipPort: UserOwnershipPort,
  userId: string,
  sessionId: string,
): Promise<SessionOwnershipView> {
  try {
    const view = await ownershipPort.loadSessionOwnership(sessionId);
    assertOwnershipView(view, userId);
    assertWritableView(view);
    return view;
  } catch (error) {
    throw toDomainError(error, "SESSION_FORBIDDEN");
  }
}

export function assertWritableOwnership(view: SessionOwnershipView): void {
  try {
    assertWritableView(view);
  } catch (error) {
    throw toDomainError(error, "SESSION_ARCHIVED");
  }
}

import { CandidateProfileService } from "@/lib/career/candidateProfileService";
import { log } from "@/lib/telemetry";
import { BackupError } from "@/lib/backup/schema";
import { normalizeBackupData } from "@/lib/backup/compat";

vi.mock("@/lib/career/capabilities", () => ({
  assertResumeV1Writable: vi.fn().mockResolvedValue("AB_ENABLED"),
}));

const ID = "SENSITIVE_ID_SENTINEL_123";
const PHONE = "SENSITIVE_PHONE_SENTINEL_456";
const NAME = "SENSITIVE_NAME_SENTINEL";

describe("sensitive logging guards", () => {
  beforeEach(() => {
    vi.spyOn(log, "info").mockImplementation(() => undefined);
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(log, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captured(): string {
    const calls = [
      ...(log.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(log.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(log.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    return JSON.stringify(calls);
  }

  it("does not log sensitive service input or echo it in errors", async () => {
    const db = {
      candidateSensitiveInfo: { upsert: vi.fn().mockRejectedValue(new Error(ID)) },
    };
    const service = new CandidateProfileService(db as never, "user-1");
    await expect(
      service.upsertCandidateSensitiveInfo("user-1", {
        idNumber: ID,
        emergencyContactName: NAME,
        emergencyContactPhone: PHONE,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const text = JSON.stringify(error);
      expect(text).not.toContain(ID);
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain(NAME);
      return true;
    });
    expect(captured()).not.toContain(ID);
    expect(captured()).not.toContain(PHONE);
    expect(captured()).not.toContain(NAME);
  });

  it("does not put sensitive payload values in backup import failure messages", () => {
    expect(() =>
      normalizeBackupData(
        {
          CandidateSensitiveInfo: [
            {
              id: "s1",
              idNumber: ID,
              emergencyContactName: NAME,
              emergencyContactPhone: PHONE,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          CandidateFamilyMember: [
            {
              id: "f1",
              sensitiveInfoId: "s1",
              name: NAME,
              phone: PHONE,
              sortOrder: 10,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        false,
      ),
    ).toThrow(BackupError);
    try {
      normalizeBackupData(
        {
          CandidateSensitiveInfo: [
            {
              id: "s1",
              idNumber: ID,
              emergencyContactPhone: PHONE,
            },
          ],
        },
        false,
      );
    } catch (error) {
      const text = error instanceof BackupError ? error.userMessage : String(error);
      expect(text).not.toContain(ID);
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain(NAME);
    }
    expect(captured()).not.toContain(ID);
    expect(captured()).not.toContain(PHONE);
  });
});

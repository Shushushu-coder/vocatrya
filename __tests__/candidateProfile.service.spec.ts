import { CandidateProfileService } from "@/lib/career/candidateProfileService";
import { CareerRuntimeError } from "@/lib/career/errors";

vi.mock("@/lib/career/capabilities", () => ({
  assertResumeV1Writable: vi.fn().mockResolvedValue("AB_ENABLED"),
}));

function dbMock() {
  return {
    candidateProfile: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    candidateSensitiveInfo: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    candidateFamilyMember: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
}

describe("CandidateProfileService validation", () => {
  it("rejects an invalid gender without echoing the value", async () => {
    const db = dbMock();
    const service = new CandidateProfileService(db as never, "user-1");
    await expect(
      service.upsertCandidateProfile("user-1", { gender: "not-a-gender" }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CareerRuntimeError);
      const err = error as CareerRuntimeError;
      expect(err.code).toBe("INVALID_GENDER");
      expect(err.message).not.toContain("not-a-gender");
      return true;
    });
    expect(db.candidateProfile.upsert).not.toHaveBeenCalled();
  });

  it("rejects an impossible birthDate without converting to DateTime", async () => {
    const db = dbMock();
    const service = new CandidateProfileService(db as never, "user-1");
    await expect(
      service.upsertCandidateProfile("user-1", { birthDate: "2026-13-99" }),
    ).rejects.toMatchObject({ code: "INVALID_BIRTH_DATE" });
    expect(db.candidateProfile.upsert).not.toHaveBeenCalled();
  });

  it("rejects an unknown politicalStatus", async () => {
    const db = dbMock();
    const service = new CandidateProfileService(db as never, "user-1");
    await expect(
      service.upsertCandidateProfile("user-1", { politicalStatus: "未知党派" }),
    ).rejects.toMatchObject({ code: "INVALID_POLITICAL_STATUS" });
  });

  it("accepts a valid YYYY-MM-DD birthDate as a string", async () => {
    const db = dbMock();
    db.candidateProfile.upsert.mockResolvedValue({ id: "p1" });
    const service = new CandidateProfileService(db as never, "user-1");
    await service.upsertCandidateProfile("user-1", {
      birthDate: "1998-02-03",
      gender: "女",
      politicalStatus: "群众",
    });
    const create = db.candidateProfile.upsert.mock.calls[0][0].create;
    expect(create.birthDate).toBe("1998-02-03");
    expect(create.gender).toBe("女");
  });
});

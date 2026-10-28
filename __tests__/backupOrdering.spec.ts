import {
  INTERVIEW_SPEC_COMMIT,
  INTERVIEW_SPEC_TAG,
  MODEL_SPECS,
  INSERT_ORDER,
  DELETE_ORDER,
  USER_WIPE_ORDER,
  QUESTION_BANK_CANONICAL_METADATA_FIELDS,
  QUESTION_BANK_EXCLUDED_COMPARISON_FIELDS,
  QUESTION_BANK_IDENTITY_FIELDS,
  QUESTION_BANK_IN_DELETE_ORDER,
  QUESTION_BANK_VERSION_CONFLICT,
  LOOKUP_MODELS,
  EMPTINESS_MODELS,
  DEFERRED_FKS,
  STANDARD_BACKUP_MODELS,
  SENSITIVE_BACKUP_MODELS,
  modelsForWipe,
  type BackupModel,
} from "@/lib/backup/ordering";

describe("backup ordering", () => {
  it("lists every model in MODEL_SPECS exactly once in INSERT_ORDER", () => {
    const specKeys = Object.keys(MODEL_SPECS).sort();
    const orderKeys = [...INSERT_ORDER].sort();
    expect(orderKeys).toEqual(specKeys);
    expect(new Set(INSERT_ORDER).size).toBe(INSERT_ORDER.length);
  });

  it("keeps cyclic current-pointer FKs out of MODEL_SPECS so insert order stays acyclic", () => {
    for (const { model, field, target } of DEFERRED_FKS) {
      expect(MODEL_SPECS[model].fks).not.toHaveProperty(field);
      expect(INSERT_ORDER).toContain(target);
    }
  });

  it("inserts every foreign-key target before the model that references it", () => {
    const position = new Map<BackupModel, number>(
      INSERT_ORDER.map((m, i) => [m, i]),
    );
    for (const model of INSERT_ORDER) {
      for (const [field, target] of Object.entries(MODEL_SPECS[model].fks)) {
        expect(
          position.get(target)! < position.get(model)!,
          `${model}.${field} -> ${target} is inserted too late`,
        ).toBe(true);
      }
    }
  });

  it("wipes in reverse insert order minus reference data (QuestionBank never wiped)", () => {
    // Spec v1 §15: QuestionBank = REFERENCE_DATA restored but not wiped, so
    // the global DELETE_ORDER = exact reverse INSERT_ORDER invariant no longer
    // holds. The per-user wipe set is the filtered reverse.
    expect(QUESTION_BANK_IN_DELETE_ORDER).toBe(false);
    expect(DELETE_ORDER).not.toContain("QuestionBank");
    expect(USER_WIPE_ORDER).not.toContain("QuestionBank");
    expect(USER_WIPE_ORDER).toEqual(DELETE_ORDER);
    expect(DELETE_ORDER).toEqual(
      [...INSERT_ORDER].reverse().filter((m) => m !== "QuestionBank"),
    );
    expect(MODEL_SPECS.QuestionBank.wipeMode).toBe("none");
    expect(modelsForWipe(false)).not.toContain("QuestionBank");
    expect(modelsForWipe(true)).not.toContain("QuestionBank");
  });

  it("keeps QuestionBank in the restore graph before QuestionBankItem", () => {
    // NOT_WIPED != NOT_RESTORED: reference banks resolve before memberships
    // so QuestionBankItem.bankId can map source → final target id.
    expect(INSERT_ORDER).toContain("QuestionBank");
    expect(INSERT_ORDER).toContain("QuestionBankItem");
    expect(INSERT_ORDER.indexOf("QuestionBank")).toBeLessThan(
      INSERT_ORDER.indexOf("QuestionBankItem"),
    );
    expect(MODEL_SPECS.QuestionBankItem.fks.bankId).toBe("QuestionBank");
  });

  it("freezes QuestionBank identity and canonical metadata field sets", () => {
    expect([...QUESTION_BANK_IDENTITY_FIELDS]).toEqual(["bankKey", "version"]);
    expect([...QUESTION_BANK_CANONICAL_METADATA_FIELDS]).toEqual([
      "title",
      "locale",
      "kind",
    ]);
    expect([...QUESTION_BANK_EXCLUDED_COMPARISON_FIELDS]).toEqual([
      "id",
      "createdAt",
      "updatedAt",
    ]);
    expect(QUESTION_BANK_VERSION_CONFLICT).toBe(
      "QUESTION_BANK_VERSION_CONFLICT",
    );
  });

  it("records the exact InterviewDx spec identity under test", () => {
    expect(INTERVIEW_SPEC_TAG).toBe("interview-vocatrya-spec-v1");
    expect(INTERVIEW_SPEC_COMMIT).toBe(
      "a7a8e2ed75e3797c207851f62e3a13732d405f6d",
    );
  });

  // The two edges the intuitive reading gets backwards.
  it("inserts Summary before ResumeSection, because ResumeSection holds summaryId", () => {
    expect(MODEL_SPECS.ResumeSection.fks.summaryId).toBe("Summary");
    expect(MODEL_SPECS.Summary.fks).toEqual({});
    expect(INSERT_ORDER.indexOf("Summary")).toBeLessThan(
      INSERT_ORDER.indexOf("ResumeSection"),
    );
  });

  it("remaps ContactInfo through resumeId, not resumeSectionId", () => {
    expect(MODEL_SPECS.ContactInfo.fks).toEqual({ resumeId: "Resume" });
    expect(MODEL_SPECS.ContactInfo.fks).not.toHaveProperty("resumeSectionId");
  });

  it("inserts ContactRole before JobContact, and Contact after Company and Location", () => {
    const at = (m: BackupModel) => INSERT_ORDER.indexOf(m);
    expect(at("ContactRole")).toBeLessThan(at("JobContact"));
    expect(at("Contact")).toBeLessThan(at("JobContact"));
    expect(at("Company")).toBeLessThan(at("Contact"));
    expect(at("Location")).toBeLessThan(at("Contact"));
  });

  it("scopes JobContact through the job, which is the only chain it has", () => {
    expect(MODEL_SPECS.JobContact.scope("u1")).toEqual({
      Job: { userId: "u1" },
    });
    expect(MODEL_SPECS.JobContact.fks).toEqual({
      jobId: "Job",
      contactId: "Contact",
      roleId: "ContactRole",
    });
  });

  it("remaps both of Contact's company FKs, not just the current employer", () => {
    expect(MODEL_SPECS.Contact.fks).toEqual({
      interviewId: "Interview",
      companyId: "Company",
      locationId: "Location",
      workedAtCompanyId: "Company",
      roleId: "ContactRole",
    });
  });

  it("marks exactly the seven lookup models, all owned by createdBy", () => {
    expect([...LOOKUP_MODELS].sort()).toEqual([
      "ActivityType",
      "Company",
      "ContactRole",
      "JobSource",
      "JobTitle",
      "Location",
      "Tag",
    ]);
    for (const model of LOOKUP_MODELS) {
      expect(MODEL_SPECS[model].owner).toBe("createdBy");
      expect(MODEL_SPECS[model].fks).toEqual({});
    }
  });

  it("scopes every model to a user, directly or through a relation chain", () => {
    for (const model of INSERT_ORDER) {
      const where = MODEL_SPECS[model].scope("user-1");
      if (model === "AbMigrationState") {
        expect(where).toEqual({});
        continue;
      }
      // QuestionBank is system-managed global reference data (spec v1 §8):
      // no owner column, exports every bank as a REFERENCE_DATA_SNAPSHOT so a
      // restore can rebuild a missing canonical bank, but it is never
      // user-wiped (wipeMode "none"). QuestionBankItem stays user-scoped via
      // Question.createdBy.
      if (model === "QuestionBank") {
        expect(where).toEqual({});
        continue;
      }
      expect(JSON.stringify(where)).toContain("user-1");
    }
  });

  it("scopes the models whose ownership chain is easy to get wrong", () => {
    expect(MODEL_SPECS.File.scope("u1")).toEqual({
      Resume: { profile: { userId: "u1" } },
    });
    expect(MODEL_SPECS.Summary.scope("u1")).toEqual({
      ResumeSection: { Resume: { profile: { userId: "u1" } } },
    });
    expect(MODEL_SPECS.ContactInfo.scope("u1")).toEqual({
      resume: { profile: { userId: "u1" } },
    });
    expect(MODEL_SPECS.Interview.scope("u1")).toEqual({
      job: { userId: "u1" },
    });
    expect(MODEL_SPECS.AutomationRun.scope("u1")).toEqual({
      automation: { userId: "u1" },
    });
  });
});

describe("emptiness models", () => {
  it("counts content models only, so seeded JobSource rows do not demand a wipe", () => {
    expect([...EMPTINESS_MODELS].sort()).toEqual([
      "AIBusinessAssignment",
      "AIConnection",
      "ApplicationAttempt",
      "Automation",
      "CandidateAttachment",
      "CandidateProfile",
      "CandidateReferee",
      "CareerMaterialItem",
      "Contact",
      "CoverLetter",
      "InterviewSession",
      "Job",
      "JobOpportunity",
      "JobSearchPreference",
      "MatchAnalysis",
      "Note",
      "Profile",
      "Question",
      "RecruitmentCampaign",
      "Resume",
      "ResumeVariant",
      "Task",
    ]);
  });

  it("includes no lookup model", () => {
    for (const model of LOOKUP_MODELS) {
      expect(EMPTINESS_MODELS).not.toContain(model);
    }
  });

  it("includes Profile, so an import cannot add a second one", () => {
    expect(EMPTINESS_MODELS).toContain("Profile");
  });
});

describe("backup datasets", () => {
  it("keeps sensitive models out of the standard restore wipe", () => {
    expect([...SENSITIVE_BACKUP_MODELS]).toEqual([
      "CandidateSensitiveInfo",
      "CandidateFamilyMember",
      "CandidateReferee",
      "CandidateAttachment",
    ]);
    expect(STANDARD_BACKUP_MODELS).not.toEqual(
      expect.arrayContaining([...SENSITIVE_BACKUP_MODELS]),
    );
    expect(modelsForWipe(false)).not.toEqual(
      expect.arrayContaining([...SENSITIVE_BACKUP_MODELS]),
    );
    expect(modelsForWipe(true)).toEqual(
      expect.arrayContaining([...SENSITIVE_BACKUP_MODELS]),
    );
    expect(INSERT_ORDER.indexOf("CandidateSensitiveInfo")).toBeLessThan(
      INSERT_ORDER.indexOf("CandidateFamilyMember"),
    );
    expect(DELETE_ORDER.indexOf("CandidateFamilyMember")).toBeLessThan(
      DELETE_ORDER.indexOf("CandidateSensitiveInfo"),
    );
  });

  it("does not put sensitive models on the global DELETE_ORDER-only path by accident", () => {
    expect(DELETE_ORDER).toEqual(
      [...INSERT_ORDER].reverse().filter((m) => m !== "QuestionBank"),
    );
    for (const model of SENSITIVE_BACKUP_MODELS) {
      expect(MODEL_SPECS[model].dataset).toBe("sensitive");
    }
  });

  it("keeps QuestionBankItem user-scoped via Question.createdBy", () => {
    expect(MODEL_SPECS.QuestionBankItem.scope("u1")).toEqual({
      question: { createdBy: "u1" },
    });
    expect(MODEL_SPECS.QuestionBankItem.fks).toEqual({
      bankId: "QuestionBank",
      questionId: "Question",
    });
  });
});

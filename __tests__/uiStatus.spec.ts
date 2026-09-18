import {
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  OPPORTUNITY_STATUS,
  deriveUiStatus,
  planUiStatusWrite,
} from "@/lib/career";

function attemptForPlan(plan: ReturnType<typeof planUiStatusWrite>) {
  if (plan.kind !== "attempt") {
    throw new Error(`expected attempt plan, got ${plan.kind}`);
  }
  return {
    currentStageCategory: plan.currentStageCategory,
    outcome: plan.outcome,
    submittedAt: plan.markSubmitted ? new Date("2026-01-01T00:00:00.000Z") : null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("planUiStatusWrite inverse of deriveUiStatus", () => {
  it.each([
    ["applied", ATTEMPT_STAGE.SUBMITTED, ATTEMPT_OUTCOME.ACTIVE],
    ["interview", ATTEMPT_STAGE.INTERVIEW, ATTEMPT_OUTCOME.ACTIVE],
    ["offer", ATTEMPT_STAGE.OFFER, ATTEMPT_OUTCOME.OFFER],
    ["rejected", ATTEMPT_STAGE.CLOSED, ATTEMPT_OUTCOME.REJECTED],
    ["offer-accepted", ATTEMPT_STAGE.CLOSED, ATTEMPT_OUTCOME.HIRED],
    ["offer-declined", ATTEMPT_STAGE.CLOSED, ATTEMPT_OUTCOME.WITHDRAWN],
  ] as const)(
    "maps %s onto existing Attempt stage/outcome enums",
    (uiStatus, stage, outcome) => {
      const plan = planUiStatusWrite(uiStatus);
      expect(plan).toMatchObject({
        kind: "attempt",
        currentStageCategory: stage,
        outcome,
      });
      expect(
        deriveUiStatus({
          archivedAt: null,
          opportunityStatus: OPPORTUNITY_STATUS.UNKNOWN,
          attempt: attemptForPlan(plan),
        }),
      ).toBe(uiStatus);
    },
  );

  it("maps expired and archived onto opportunity fields, not Attempt", () => {
    expect(planUiStatusWrite("expired")).toEqual({ kind: "expire-opportunity" });
    expect(planUiStatusWrite("archived")).toEqual({ kind: "archive-opportunity" });
    expect(
      deriveUiStatus({
        archivedAt: new Date(),
        opportunityStatus: OPPORTUNITY_STATUS.UNKNOWN,
        attempt: null,
      }),
    ).toBe("archived");
    expect(
      deriveUiStatus({
        archivedAt: null,
        opportunityStatus: OPPORTUNITY_STATUS.EXPIRED,
        attempt: null,
      }),
    ).toBe("expired");
  });

  it("does not invent mappings for draft or unknown legacy values", () => {
    expect(planUiStatusWrite("draft")).toEqual({ kind: "noop" });
    expect(planUiStatusWrite("new")).toEqual({ kind: "noop" });
    expect(planUiStatusWrite("accepted")).toEqual({ kind: "noop" });
    expect(planUiStatusWrite("dismissed")).toEqual({ kind: "noop" });
  });

  it("displays TRANSFERRED natively and does not map it onto rejected or withdrawn", () => {
    expect(planUiStatusWrite("transferred")).toEqual({ kind: "noop" });
    expect(
      deriveUiStatus({
        archivedAt: null,
        opportunityStatus: OPPORTUNITY_STATUS.UNKNOWN,
        attempt: {
          currentStageCategory: ATTEMPT_STAGE.SUBMITTED,
          outcome: ATTEMPT_OUTCOME.TRANSFERRED,
          submittedAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      }),
    ).toBe("transferred");
  });
});

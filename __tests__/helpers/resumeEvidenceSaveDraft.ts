import {
  buildResumeEvidenceStart,
  createInitialResumeEvidenceDraft,
  type ResumeEvidenceDraft,
} from "@/lib/agent/skills/resumeEvidence";

/** A validated, savable create_new draft (INTERNSHIP, two evidence entries). */
export function savableDraft(
  patch: (d: ResumeEvidenceDraft) => void = () => {},
): ResumeEvidenceDraft {
  const start = buildResumeEvidenceStart({ experienceText: "Led a migration" });
  if (!start.ok) throw new Error("setup");
  const d = createInitialResumeEvidenceDraft(start.pack);
  d.session = {
    stage: "ready_to_stop",
    stopReason: null,
    roundIndex: 3,
    focus: null,
    sufficiency: { met: true, missingSlots: [] },
  };
  d.next = { ...d.next, recommendation: "wait_for_save_confirmation", questionBudget: 0 };
  d.confirmedFacts = [
    {
      id: "f1",
      text: "Moved 12 services to the new queue",
      slot: "action",
      epistemic: "user_stated",
      sourceRefs: ["src-paste"],
      attribution: "personal",
    },
    {
      id: "f2",
      text: "Cut p95 latency by 30%",
      slot: "result",
      epistemic: "user_stated",
      sourceRefs: ["src-paste"],
      attribution: "personal",
    },
  ];
  d.materialMapping = {
    ...d.materialMapping,
    type: "INTERNSHIP",
    futureOperation: "create_new",
    blockedWrites: [],
    futureEntrypoints: ["createApplicationMaterial", "addApplicationMaterialEvidence"],
    parent: {
      title: "Acme backend intern",
      startDate: "2024-06-01",
      endDate: "2024-09-01",
      isCurrent: false,
      notes: null,
    },
    detail: { organizationName: "Acme", roleTitle: "Intern" },
    evidenceToAdd: [
      {
        content: "Moved 12 services to the new queue",
        metricText: null,
        kindOnWrite: "FACT",
        semanticRole: "action",
        basisFactIds: ["f1"],
        userAcceptedAsEvidence: true,
      },
      {
        content: "Cut p95 latency",
        metricText: "30%",
        kindOnWrite: "FACT",
        semanticRole: "outcome",
        basisFactIds: ["f2"],
        userAcceptedAsEvidence: true,
      },
    ],
  };
  patch(d);
  return d;
}

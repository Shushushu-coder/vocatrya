import {
  DRAFT_ONLY_MARKER_CODE,
  getResumeEvidenceSaveEligibility,
  savingBlockers,
} from "@/lib/agent/skills/resumeEvidence";
import { savableDraft } from "./helpers/resumeEvidenceSaveDraft";

describe("DRAFT_ONLY_V1 marker carried over by the model", () => {
  it("does not block saving on its own", () => {
    const d = savableDraft((x) => {
      x.materialMapping.blockedWrites = [
        { code: DRAFT_ONLY_MARKER_CODE, message: "首版只产出草稿，不执行保存。" },
      ];
    });
    expect(getResumeEvidenceSaveEligibility(d)).toMatchObject({ ok: true });
    expect(savingBlockers(d.materialMapping.blockedWrites)).toEqual([]);
  });

  it("a real block next to the marker still blocks", () => {
    const d = savableDraft((x) => {
      x.materialMapping.blockedWrites = [
        { code: DRAFT_ONLY_MARKER_CODE, message: "首版只产出草稿，不执行保存。" },
        { code: "DETAIL_COLUMN_NOT_WHITELISTED", message: "favouriteColour 不在白名单" },
      ];
    });
    expect(getResumeEvidenceSaveEligibility(d)).toMatchObject({ ok: false, code: "blocked_writes" });
    expect(savingBlockers(d.materialMapping.blockedWrites)).toHaveLength(1);
  });
});

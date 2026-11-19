import type { AgentRole } from "@/lib/agent/agentRoles";
import { RESUME_EVIDENCE_SKILL_ID } from "./resumeEvidence/contract";

// Registry of curated built-in skills shown on the extensions page "Skills"
// tab. Only skills that actually exist belong here — adding a skill is one
// entry plus its i18n keys (`extensions.skills.items.<i18nKey>.*`).
// Third-party skill import is intentionally NOT supported (coming soon).

export interface BuiltInSkillEntry {
  id: string;
  /** Key segment under `extensions.skills.items`. */
  i18nKey: string;
  /** Agent role that hosts the skill (the chat panel opens on this role). */
  hostRole: AgentRole;
  /** Run mode; copy lives under `extensions.skills.modes`. */
  mode: "draftOnly";
}

export const BUILT_IN_SKILLS: readonly BuiltInSkillEntry[] = [
  {
    id: RESUME_EVIDENCE_SKILL_ID,
    i18nKey: "resumeEvidence",
    hostRole: "pilot",
    mode: "draftOnly",
  },
];

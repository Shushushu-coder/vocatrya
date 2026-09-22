/**
 * PRODUCT preset — InterviewDx SAMPLE_FIXTURE (not research export).
 * Source: InterviewDx vocatrya-port src/presets/sample.ts
 */
import type { PresetManifest } from "./schema";

export const SAMPLE_PRESET: PresetManifest = {
  bankKey: "interviewdx.sample.behavioral.v1",
  version: "1.0.0",
  title: "InterviewDx sample behavioral bank",
  locale: "zh",
  kind: "SAMPLE_FIXTURE",
  items: [
    {
      itemKey: "self-intro",
      promptText: "请用两分钟做自我介绍，并说明你为什么适合这个岗位。",
      referenceAnswer:
        "结构化介绍背景、关键经历、与岗位的匹配点，并以可验证成果收束。",
      category: "自我介绍",
      locale: "zh",
      sourceKind: "QUESTION_BANK",
      sourceProvenance: {
        origin: "SAMPLE_FIXTURE",
        unresolvedBankAttribution: false,
      },
    },
    {
      itemKey: "conflict",
      promptText: "请讲述一次你与同事发生意见冲突并最终推动事情前进的经历。",
      referenceAnswer: "用 STAR 说明冲突背景、你的责任、具体沟通行动和可量化结果。",
      category: "行为题",
      locale: "zh",
      sourceKind: "QUESTION_BANK",
      sourceProvenance: {
        origin: "SAMPLE_FIXTURE",
        unresolvedBankAttribution: false,
      },
    },
    {
      itemKey: "failure",
      promptText: "请描述一次你负责的项目未达预期的经历，以及你从中学到了什么。",
      referenceAnswer:
        "交代目标与失败点，区分个人责任，给出改进动作和对后续工作的影响。",
      category: "行为题",
      locale: "zh",
      sourceKind: "QUESTION_BANK",
      sourceProvenance: {
        origin: "SAMPLE_FIXTURE",
        unresolvedBankAttribution: false,
      },
    },
  ],
};

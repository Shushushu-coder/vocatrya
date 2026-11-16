"use client";

import { useState } from "react";
import { useI18n } from "@/i18n";
import { useDictation } from "@/lib/dictation/useDictation";
import { dictationErrorKey } from "@/components/agent/AgentDictationButton";
import { Button } from "../ui/button";

export function DictationTestControls({ enabled, ownershipKey }: { enabled: boolean; ownershipKey: string }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const dictation = useDictation({
    ownershipKey,
    maxDurationMs: 15_000,
    onTranscript: setText,
  });
  const busy = ["acquiring", "recording", "transcribing"].includes(dictation.phase);
  return <div className="space-y-2 border-t pt-3" data-testid="dictation-test">
    <p className="text-sm text-muted-foreground">{t("dictation.testHint")}</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={!enabled || busy} onClick={() => { setText(""); dictation.start(); }}>
        {t("dictation.testStart")}
      </Button>
      {dictation.phase === "recording" && <Button size="sm" onClick={dictation.stop}>{t("dictation.stop")} ({Math.floor(dictation.elapsedMs / 1000)}s)</Button>}
      {busy && <Button size="sm" variant="ghost" onClick={dictation.cancel}>{t("dictation.cancel")}</Button>}
      {dictation.phase === "acquiring" && <span role="status">{t("dictation.requestingMic")}</span>}
      {dictation.phase === "transcribing" && <span role="status">{t("dictation.transcribing")}</span>}
      {dictation.canRetry && enabled && <Button size="sm" variant="outline" onClick={dictation.retry}>{t("dictation.retry")}</Button>}
    </div>
    {!enabled && <p className="text-xs text-muted-foreground">{t("dictation.testSaveFirst")}</p>}
    {dictation.error && <p role="alert" className="text-sm text-destructive">{t(dictationErrorKey(dictation.error))}</p>}
    {text && <div role="status" className="space-y-1 text-sm"><p>{t("dictation.testPassed")}</p><p className="whitespace-pre-wrap break-words">{text}</p></div>}
  </div>;
}

"use client";

import { useMemo } from "react";
import { TipTapContentViewer } from "@/components/TipTapContentViewer";
import { AgentCodeBlock } from "@/components/agent/AgentCodeBlock";
import {
  renderAgentMarkdown,
  splitAgentMarkdown,
} from "@/lib/agent/markdown";

// Re-rendered per streamed chunk, matching the review sheet's onUpdate
// snapshots. Half-open markdown flickers for a frame; the old surface has
// always lived with that and it is the price of progressive formatting.
export function AgentMarkdown({ text }: { text: string }) {
  const segments = useMemo(() => splitAgentMarkdown(text), [text]);
  if (segments.length === 0) return null;
  return (
    <div className="text-sm leading-relaxed [&_p]:mt-2 [&_ul]:mt-2 [&_ol]:mt-2 [&_h2]:mt-4 [&_h2]:font-semibold [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4">
      {segments.map((segment, i) =>
        segment.kind === "code" ? (
          <AgentCodeBlock
            key={i}
            code={segment.code}
            language={segment.language}
          />
        ) : (
          <MarkdownPart key={i} text={segment.text} />
        ),
      )}
    </div>
  );
}

function MarkdownPart({ text }: { text: string }) {
  const html = useMemo(() => renderAgentMarkdown(text), [text]);
  if (!html) return null;
  return <TipTapContentViewer content={html} />;
}

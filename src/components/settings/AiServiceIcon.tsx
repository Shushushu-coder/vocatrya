import Image from "next/image";

// Original SVG variants are stored locally with their source and license.
const icons: Record<string, string> = {
  ChatGPT: "openai.svg",
  Claude: "claude-color.svg",
  OpenCode: "opencode.svg",
  Grok: "grok.svg",
  Cursor: "cursor.svg",
  Devin: "devin-color.svg",
  DeepSeek: "deepseek-color.svg",
  OpenRouter: "openrouter-color.svg",
  Antigravity: "antigravity-color.svg",
};

export default function AiServiceIcon({ name }: { name: string }) {
  const file = icons[name];
  if (!file) return null;
  return (
    <Image
      src={`/icons/ai-services/${file}`}
      alt=""
      width={24}
      height={24}
      unoptimized
      className="size-6 object-contain"
    />
  );
}

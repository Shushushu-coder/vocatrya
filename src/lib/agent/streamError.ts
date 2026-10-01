export const STREAM_ERROR_PREFIX = "agent-code:";

export function parseAgentStreamError(message: string): {
  code: string;
  message: string;
} | null {
  if (!message.startsWith(STREAM_ERROR_PREFIX)) return null;
  const newline = message.indexOf("\n");
  if (newline <= STREAM_ERROR_PREFIX.length) return null;
  return {
    code: message.slice(STREAM_ERROR_PREFIX.length, newline),
    message: message.slice(newline + 1),
  };
}

import type { DictationErrorCode } from "./config";

export class DictationClientError extends Error {
  readonly code: DictationErrorCode | "HTTP" | "BAD_RESPONSE";

  constructor(code: DictationClientError["code"], message: string) {
    super(message);
    this.name = "DictationClientError";
    this.code = code;
  }
}

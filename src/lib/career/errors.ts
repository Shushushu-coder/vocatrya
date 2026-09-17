export class CareerRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CareerRuntimeError";
    this.code = code;
  }
}

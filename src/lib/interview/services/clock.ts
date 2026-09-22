/**
 * Clock — local DI (NOT Host Port v0).
 * Source: InterviewDx vocatrya-port src/services/clock.ts (IMPORT_REWRITE).
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class ManualClock implements Clock {
  private current: number;

  constructor(initial: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.current = initial.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(date: Date): void {
    this.current = date.getTime();
  }

  advanceByMs(ms: number): void {
    this.current += ms;
  }
}

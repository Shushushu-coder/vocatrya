import type { VocatryaMotionState } from "./VocatryaMark";

export function mountVocatryaMotion(
  svg: SVGSVGElement,
  id: string,
  initialState?: VocatryaMotionState,
): { setState(state: VocatryaMotionState): void; dispose(): void };

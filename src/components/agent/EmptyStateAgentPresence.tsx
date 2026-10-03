"use client";

import { useEffect, useId, useRef } from "react";
import { masterPaths } from "@/components/brand/geometry";
import type { VocatryaMotionState } from "@/components/brand/VocatryaMark";
import { mountEmptyStateMotion } from "./empty-state-motion";
import styles from "./empty-state.module.css";

export function EmptyStateAgentPresence({ state = "idle" }: { state?: VocatryaMotionState }) {
  const svg = useRef<SVGSVGElement>(null);
  const controller = useRef<ReturnType<typeof mountEmptyStateMotion> | null>(null);
  const initialState = useRef(state);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  useEffect(() => {
    if (!svg.current) return;
    const motion = mountEmptyStateMotion(svg.current, `empty-a15-${id}`, initialState.current);
    controller.current = motion;
    return () => { motion.dispose(); controller.current = null; };
  }, [id]);
  useEffect(() => { controller.current?.setState(state); }, [state]);
  return (
    <svg ref={svg} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144"
      fill="currentColor" width={72} height={72} className={styles.mark}
      aria-hidden="true" focusable="false" data-vocatrya-mark=""
      data-animated="true" data-state={state}>
      <g transform="translate(-9 -16)">
        {masterPaths.map((d, i) => <path data-fragment="" key={i} d={d} />)}
      </g>
    </svg>
  );
}

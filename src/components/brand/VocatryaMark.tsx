"use client";

import { useEffect, useId, useRef } from "react";
import { masterPaths, opticalPaths } from "./geometry";
import { mountVocatryaMotion } from "./motion";
import styles from "./mark.module.css";

export type VocatryaMotionState = "idle" | "thinking" | "complete";

export function VocatryaMark({
  size = 24,
  state = "idle",
  animated = false,
  className = "",
}: {
  size?: number;
  state?: VocatryaMotionState;
  animated?: boolean;
  className?: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const controller = useRef<ReturnType<typeof mountVocatryaMotion> | null>(null);
  const initialState = useRef(state);
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const optical = size <= 24;

  useEffect(() => {
    if (!animated || size < 24 || !svg.current) return;
    const motion = mountVocatryaMotion(svg.current, `a15-${id}`, initialState.current);
    controller.current = motion;
    return () => {
      motion.dispose();
      controller.current = null;
    };
  }, [animated, id, optical, size]);

  useEffect(() => {
    controller.current?.setState(state);
  }, [state, animated, size]);

  return (
    <svg
      ref={svg}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 144 144"
      fill="currentColor"
      width={size}
      height={size}
      className={`${styles.mark} ${className}`}
      aria-hidden="true"
      focusable="false"
      data-vocatrya-mark=""
      data-animated={animated && size >= 24}
      data-state={state}
    >
      <g transform="translate(-9 -16)">
        {(optical ? opticalPaths : masterPaths).map((d, i) => <path key={i} d={d} />)}
      </g>
    </svg>
  );
}

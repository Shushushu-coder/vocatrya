import type { VocatryaMotionState } from "@/components/brand/VocatryaMark";

const svgNS = "http://www.w3.org/2000/svg";
const periods = [3800, 4700, 5300];
const phases = [.08, .43, .71];
const strengths = [.68, .59, .64];
const smooth = (t: number) => t * t * (3 - 2 * t);
// Blend positions by visible light energy: an invisible ambient band may reset
// at its seam even while a completion highlight is still fading out.
function blendLight(fromLight: number, fromOpacity: number, light: number, opacity: number, t: number) {
  const a = fromOpacity * (1 - t), b = opacity * t;
  return { light: a + b > 0 ? (fromLight * a + light * b) / (a + b) : light, opacity: a + b };
}

// Each fragment's phase drives geometry and material flow together. State changes
// interpolate speed/amplitude without replacing the phase clock.
export function mountEmptyStateMotion(
  svg: SVGSVGElement, id: string, initialState: VocatryaMotionState = "idle",
) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const paths = [...svg.querySelectorAll<SVGPathElement>("[data-fragment]")];
  const defs = document.createElementNS(svgNS, "defs");
  svg.prepend(defs);
  const fragments = paths.map((path, index) => {
    const box = path.getBBox();
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const dx = 78 - center.x, dy = 95 - center.y;
    const length = Math.hypot(dx, dy);
    const axis = { x: dx / length, y: dy / length };
    const total = path.getTotalLength();
    const projections = Array.from({ length: 192 }, (_, i) => {
      const point = path.getPointAtLength(total * i / 192);
      return (point.x - center.x) * axis.x + (point.y - center.y) * axis.y;
    });
    const min = Math.min(...projections), span = Math.max(...projections) - min;
    const outer = { x: center.x + min * axis.x, y: center.y + min * axis.y };
    const clip = document.createElementNS(svgNS, "clipPath");
    clip.id = id + "-" + index;
    clip.append(path.cloneNode());
    clip.firstElementChild?.removeAttribute("data-fragment");
    defs.append(clip);
    const gradient = document.createElementNS(svgNS, "linearGradient");
    gradient.id = id + "-light-" + index;
    gradient.setAttribute("gradientUnits", "userSpaceOnUse");
    for (const [key, value] of Object.entries({
      x1: outer.x - .3 * span * axis.x, y1: outer.y - .3 * span * axis.y,
      x2: outer.x + .3 * span * axis.x, y2: outer.y + .3 * span * axis.y,
    })) gradient.setAttribute(key, String(value));
    for (const [offset, opacity] of [[0, 0], [.5, 1], [1, 0]]) {
      const stop = document.createElementNS(svgNS, "stop");
      stop.setAttribute("offset", String(offset));
      stop.setAttribute("stop-opacity", String(opacity));
      stop.style.stopColor = "hsl(var(--muted-foreground))";
      gradient.append(stop);
    }
    defs.append(gradient);
    const overlay = document.createElementNS(svgNS, "g");
    overlay.setAttribute("clip-path", "url(#" + clip.id + ")");
    const band = document.createElementNS(svgNS, "polygon");
    band.setAttribute("points", [[-.3, -144], [.3, -144], [.3, 144], [-.3, 144]].map(([along, across]) =>
      (outer.x + along * span * axis.x - across * axis.y) + "," +
      (outer.y + along * span * axis.y + across * axis.x),
    ).join(" "));
    band.style.fill = "url(#" + gradient.id + ")";
    band.style.opacity = "0";
    overlay.append(band);
    path.parentElement!.append(overlay);
    return { path, overlay, band, axis, span, phase: phases[index], distance: 0, light: 0, opacity: 0 };
  });
  let state = initialState;
  let activity = initialState === "thinking" ? 1 : 0;
  let inView = false, disposed = false;
  let frame: number | undefined;
  let previous: number | undefined;
  let completion: { elapsed: number; from: { distance: number; light: number; opacity: number }[] } | undefined;
  let returnBlend: typeof completion;
  const snapshot = () => fragments.map(({ distance, light, opacity }) => ({ distance, light, opacity }));
  if (initialState === "complete") completion = { elapsed: 0, from: snapshot() };
  const active = () => !disposed && inView && !document.hidden && !reduced.matches;
  const translate = (axis: { x: number; y: number }, distance: number) =>
    "translate(" + axis.x * distance + "px, " + axis.y * distance + "px)";

  function paint() {
    fragments.forEach(({ path, overlay, band, axis, distance, light, opacity }) => {
      path.style.transform = overlay.style.transform = translate(axis, distance);
      band.style.transform = translate(axis, light);
      band.style.opacity = String(opacity);
    });
  }
  function tick(now: number) {
    frame = undefined;
    if (!active()) return;
    const dt = previous === undefined ? 0 : Math.max(0, now - previous);
    previous = now;
    activity += ((state === "thinking" ? 1 : 0) - activity) * (1 - Math.exp(-dt / 240));
    if (completion) completion.elapsed += dt;
    if (returnBlend) returnBlend.elapsed += dt;
    fragments.forEach((fragment, index) => {
      fragment.phase = (fragment.phase + dt * (1 + .75 * activity) / periods[index]) % 1;
      const p = fragment.phase;
      // Master → inward → small outward settle → master on frozen local axes.
      // No tangent, scale or rotation; distances use the 144-unit viewBox.
      const shape = p < .48 ? smooth(p / .48)
        : p < .84 ? 1 - 1.16 * smooth((p - .48) / .36)
          : -.16 * (1 - smooth((p - .84) / .16));
      let distance = shape * (4.4 + 3.2 * activity);
      let light = (-.3 + 1.6 * p) * fragment.span;
      // Zero opacity and slope at the seam: reset the invisible band outside
      // the fragment, with no whole-logo pulse.
      let opacity = Math.sin(Math.PI * p) ** 2 * (strengths[index] + .22 * activity);
      if (completion) {
        const { elapsed, from } = completion;
        if (elapsed < 390) {
          const t = smooth(elapsed / 390);
          distance = from[index].distance * (1 - t) + 7 * t;
          light = from[index].light * (1 - t) + .9 * fragment.span * t;
          opacity = from[index].opacity * (1 - t) + .92 * t;
        } else {
          const t = smooth(Math.min(1, (elapsed - 390) / 260));
          distance = 7 * (1 - t) + distance * t;
          ({ light, opacity } = blendLight(.9 * fragment.span, .92, light, opacity, t));
        }
      }
      if (returnBlend) {
        const t = smooth(Math.min(1, returnBlend.elapsed / 240));
        distance = returnBlend.from[index].distance * (1 - t) + distance * t;
        ({ light, opacity } = blendLight(returnBlend.from[index].light, returnBlend.from[index].opacity, light, opacity, t));
      }
      Object.assign(fragment, { distance, light, opacity });
    });
    if (completion && completion.elapsed >= 650) completion = undefined;
    if (returnBlend && returnBlend.elapsed >= 240) returnBlend = undefined;
    paint();
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    if (!active()) {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = previous = undefined;
      if (reduced.matches) {
        completion = undefined;
        returnBlend = undefined;
        fragments.forEach(fragment => Object.assign(fragment, { distance: 0, light: 0, opacity: 0 }));
        paint();
      }
    } else if (frame === undefined) frame = requestAnimationFrame(tick);
  }
  function setState(next: VocatryaMotionState) {
    if (next === state) return;
    state = next;
    if (next === "complete" && active()) {
      returnBlend = undefined;
      completion = { elapsed: 0, from: snapshot() };
    }
    // Finish COMPLETE even if Idle arrives early. Thinking may interrupt
    // immediately without rewinding any phase.
    if (next === "thinking" && completion) {
      returnBlend = { elapsed: 0, from: snapshot() };
      completion = undefined;
    }
  }
  const intersection = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    sync();
  });
  intersection.observe(svg);
  reduced.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  return {
    setState,
    dispose() {
      disposed = true;
      sync();
      intersection.disconnect();
      reduced.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      fragments.forEach(({ path, overlay }) => { path.style.removeProperty("transform"); overlay.remove(); });
      defs.remove();
    },
  };
}

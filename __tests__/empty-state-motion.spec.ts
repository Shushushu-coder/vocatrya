import { mountEmptyStateMotion } from "@/components/agent/empty-state-motion";

describe("continuous empty-state presence", () => {
  let svg: SVGSVGElement;
  let reduced: boolean;
  let hidden: boolean;
  let intersect: (entries: Partial<IntersectionObserverEntry>[]) => void;
  let mediaChange: () => void;
  let frames: Map<number, FrameRequestCallback>;
  let frameId: number;
  let now: number;
  let motion: ReturnType<typeof mountEmptyStateMotion>;

  beforeEach(() => {
    reduced = hidden = false;
    frames = new Map(); frameId = now = 0;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback); return frameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("matchMedia", () => ({
      get matches() { return reduced; },
      addEventListener: (_: string, fn: () => void) => { mediaChange = fn; },
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe() {} disconnect() {}
    });
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.innerHTML = '<g><path data-fragment=""/><path data-fragment=""/><path data-fragment=""/></g>';
    document.body.append(svg);
    svg.querySelectorAll("path").forEach((path, i) => {
      path.getBBox = () => ({ x: i * 30, y: i * 20, width: 20, height: 20 }) as DOMRect;
      path.getTotalLength = () => 100;
      path.getPointAtLength = value => ({ x: value, y: value / 2 }) as DOMPoint;
    });
    motion = mountEmptyStateMotion(svg, "test");
    intersect([{ isIntersecting: true }]);
  });
  afterEach(() => {
    motion.dispose(); svg.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  function step(ms = 16) {
    now += ms;
    const pending = [...frames.values()];
    frames.clear(); pending.forEach(callback => callback(now));
  }
  function advance(ms: number) { for (let t = 0; t < ms; t += 16) step(); }
  const paths = () => [...svg.querySelectorAll<SVGPathElement>("[data-fragment]")];
  const positions = () => paths().map(path => path.style.transform);
  const distance = (path: SVGPathElement) => Math.hypot(...path.style.transform.match(/-?[\d.]+/g)!.map(Number));

  it("moves immediately and continuously for 20s without pointer input or scheduled rests", () => {
    step();
    const initial = positions();
    advance(1000);
    expect(positions().every((p, i) => p !== initial[i])).toBe(true);
    for (let second = 0; second < 20; second++) {
      const before = positions(); advance(1000);
      expect(positions().every((p, i) => p !== before[i])).toBe(true);
      expect(frames.size).toBe(1);
      paths().forEach(path => expect(distance(path)).toBeLessThanOrEqual(4.4));
    }
    const before = positions();
    svg.dispatchEvent(new Event("pointerenter"));
    expect(positions()).toEqual(before);
    expect(frames.size).toBe(1);
  });
  it("enhances thinking on the same phases without a state-change jump", () => {
    step(); advance(1000);
    const before = positions();
    motion.setState("thinking");
    expect(positions()).toEqual(before);
    step();
    paths().forEach((path, i) => {
      const prior = Math.hypot(...before[i].match(/-?[\d.]+/g)!.map(Number));
      expect(Math.abs(distance(path) - prior)).toBeLessThan(.4);
    });
    let max = 0;
    for (let t = 0; t < 6000; t += 16) { step(); paths().forEach(path => { max = Math.max(max, distance(path)); }); }
    expect(max).toBeGreaterThan(7);
    expect(max).toBeLessThanOrEqual(7.6);
  });
  it("converges together then returns directly to moving Idle in 650ms", () => {
    step(); advance(1000); motion.setState("thinking"); advance(1000);
    motion.setState("complete"); advance(384);
    paths().forEach(path => expect(distance(path)).toBeCloseTo(7, 1));
    motion.setState("idle"); advance(288);
    paths().forEach(path => expect(distance(path)).toBeLessThanOrEqual(4.7));
    const settled = positions(); advance(128);
    expect(positions().every((p, i) => p !== settled[i])).toBe(true);
    expect(frames.size).toBe(1);
  });
  it("is completely static in reduced motion for all states and resumes when disabled", () => {
    step(); reduced = true; mediaChange();
    for (const state of ["thinking", "complete", "idle"] as const) {
      motion.setState(state); advance(1000);
      paths().forEach(path => expect(distance(path)).toBe(0));
      svg.querySelectorAll<SVGElement>("polygon").forEach(band => expect(band.style.opacity).toBe("0"));
      expect(frames.size).toBe(0);
    }
    reduced = false; mediaChange(); step(); advance(100);
    expect(paths().some(path => distance(path) > 0)).toBe(true);
  });
  it("blends a new Thinking turn out of maximum completion without jumping", () => {
    step(); advance(1000); motion.setState("complete"); advance(384);
    const before = paths().map(distance);
    motion.setState("thinking"); step();
    paths().forEach((path, i) => expect(Math.abs(distance(path) - before[i])).toBeLessThan(.1));
    advance(500);
    expect(frames.size).toBe(1);
    paths().forEach(path => expect(distance(path)).toBeLessThanOrEqual(7.6));
  });
  it("pauses offscreen and hidden without rewinding, and cleans up on disposal", () => {
    step(); advance(1000);
    const before = positions();
    intersect([{ isIntersecting: false }]); advance(5000);
    expect(frames.size).toBe(0); expect(positions()).toEqual(before);
    intersect([{ isIntersecting: true }]); step();
    expect(positions()).toEqual(before);
    hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    hidden = false; document.dispatchEvent(new Event("visibilitychange")); step();
    expect(positions()).toEqual(before);
    motion.dispose();
    expect(frames.size).toBe(0);
    expect(svg.querySelector("defs")).toBeNull();
    expect(svg.querySelector("polygon")).toBeNull();
    paths().forEach(path => expect(path.style.transform).toBe(""));
  });
  it.each([false, true])("keeps visible light continuous across a phase seam during completion (interrupted=%s)", interrupted => {
    step(); advance(1000); motion.setState("complete");
    if (interrupted) { advance(384); motion.setState("thinking"); }
    const bands = [...svg.querySelectorAll<SVGElement>("polygon")];
    const read = () => bands.map(band => ({
      point: band.style.transform.match(/-?[\d.]+/g)!.map(Number), opacity: Number(band.style.opacity),
    }));
    let before = read();
    for (let t = 0; t < (interrupted ? 240 : 650); t += 16) {
      step(); const after = read();
      after.forEach((sample, i) => {
        if (sample.opacity > .15 && before[i].opacity > .15) {
          expect(Math.hypot(sample.point[0] - before[i].point[0], sample.point[1] - before[i].point[1])).toBeLessThan(8);
        }
      });
      before = after;
    }
  });
});

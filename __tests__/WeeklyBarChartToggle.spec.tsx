import { act, render, screen } from "@testing-library/react";
import WeeklyBarChartToggle from "@/components/dashboard/WeeklyBarChartToggle";

// Captures the props the component hands to the real Nivo bar so the tests
// assert what the chart actually consumes, not just what the source contains.
const barProps = vi.hoisted(() => ({ current: undefined as any }));
const media = vi.hoisted(() => ({
  reduced: false,
  listeners: new Map<string, Set<(e: any) => void>>(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("@nivo/bar", () => ({
  ResponsiveBar: (props: any) => {
    barProps.current = props;
    return <div data-testid="weekly-bar" />;
  },
}));

const charts = [
  {
    label: "Jobs",
    data: [
      { day: "Mon, Jan 5", value: 3 },
      { day: "Tue, Jan 6", value: 1 },
    ],
    keys: ["value"],
    axisLeftLegend: "Jobs Applied",
  },
];

describe("WeeklyBarChartToggle", () => {
  beforeEach(() => {
    localStorage.clear();
    barProps.current = undefined;
    media.reduced = false;
    media.listeners.clear();
    vi.stubGlobal("matchMedia", (query: string) => {
      if (!media.listeners.has(query)) media.listeners.set(query, new Set());
      return {
        media: query,
        get matches() {
          return query === "(prefers-reduced-motion: reduce)"
            ? media.reduced
            : false;
        },
        addEventListener: (_: string, fn: (e: any) => void) =>
          media.listeners.get(query)!.add(fn),
        removeEventListener: (_: string, fn: (e: any) => void) =>
          media.listeners.get(query)!.delete(fn),
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables the bar chart's animation under reduced motion", () => {
    media.reduced = true;
    render(<WeeklyBarChartToggle charts={charts} />);

    expect(screen.getByTestId("weekly-bar")).toBeInTheDocument();
    expect(barProps.current.animate).toBe(false);
    expect(barProps.current.motionConfig).toBe("gentle");
  });

  it("keeps the gentle animation when reduced motion is off", () => {
    render(<WeeklyBarChartToggle charts={charts} />);

    expect(barProps.current.animate).toBe(true);
    expect(barProps.current.motionConfig).toBe("gentle");
  });

  it("stops animating when the system preference flips to reduce", () => {
    render(<WeeklyBarChartToggle charts={charts} />);
    expect(barProps.current.animate).toBe(true);

    media.reduced = true;
    act(() => {
      media.listeners
        .get("(prefers-reduced-motion: reduce)")!
        .forEach((fn) => fn({ matches: true }));
    });

    expect(barProps.current.animate).toBe(false);
  });

  it("shows an unavailable notice instead of a chart when the series is blocked", () => {
    render(
      <WeeklyBarChartToggle
        charts={[
          {
            label: "Jobs",
            data: [],
            keys: [],
            axisLeftLegend: "Jobs Applied",
            unavailable: true,
          },
          {
            label: "Activities",
            data: [{ day: "Mon, Jan 5", Jobsync: 1.5 }],
            keys: ["Jobsync"],
            groupMode: "stacked",
            axisLeftLegend: "Hours",
          },
        ]}
      />,
    );

    expect(screen.getByTestId("jobs-unavailable-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("weekly-bar")).not.toBeInTheDocument();
  });
});

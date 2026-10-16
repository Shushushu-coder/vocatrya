import { act, render, screen } from "@testing-library/react";
import { SaveStatusProvider, useSaveStatus } from "@/context/SaveStatusContext";

function Probe() {
  const { status } = useSaveStatus();
  return <output data-testid="status">{status}</output>;
}

function Harness() {
  const save = useSaveStatus();
  return (
    <>
      <Probe />
      <button
        data-testid="begin"
        onClick={() => {
          (window as unknown as { __seqs: number[] }).__seqs ??= [];
          (window as unknown as { __seqs: number[] }).__seqs.push(save.begin());
        }}
      />
      <button
        data-testid="ok"
        onClick={() => {
          const seqs = (window as unknown as { __seqs: number[] }).__seqs;
          save.finish(seqs.shift()!, true);
        }}
      />
      <button
        data-testid="fail"
        onClick={() => {
          const seqs = (window as unknown as { __seqs: number[] }).__seqs;
          save.finish(seqs.shift()!, false);
        }}
      />
    </>
  );
}

const click = (id: string) => {
  act(() => {
    screen.getByTestId(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("SaveStatusProvider", () => {
  beforeEach(() => {
    (window as unknown as { __seqs?: number[] }).__seqs = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows saving then saved, then fades back to idle", () => {
    render(
      <SaveStatusProvider>
        <Harness />
      </SaveStatusProvider>,
    );
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    click("begin");
    expect(screen.getByTestId("status")).toHaveTextContent("saving");
    click("ok");
    expect(screen.getByTestId("status")).toHaveTextContent("saved");
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
  });

  it("keeps saving while a newer request is still in flight", () => {
    render(
      <SaveStatusProvider>
        <Harness />
      </SaveStatusProvider>,
    );
    click("begin"); // seq 1
    click("begin"); // seq 2
    // The older request finishing first must not flip to saved.
    click("ok");
    expect(screen.getByTestId("status")).toHaveTextContent("saving");
    click("ok");
    expect(screen.getByTestId("status")).toHaveTextContent("saved");
  });

  it("stays on error until the next save begins", () => {
    render(
      <SaveStatusProvider>
        <Harness />
      </SaveStatusProvider>,
    );
    click("begin");
    click("fail");
    expect(screen.getByTestId("status")).toHaveTextContent("error");
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByTestId("status")).toHaveTextContent("error");
    click("begin");
    expect(screen.getByTestId("status")).toHaveTextContent("saving");
    click("ok");
    expect(screen.getByTestId("status")).toHaveTextContent("saved");
  });
});

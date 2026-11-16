import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import AiServicesLayout, { AiServiceSlot } from "@/components/settings/AiServicesLayout";

function Service() {
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState("");
  return <AiServiceSlot placement={connected ? "connected" : "available"}>
    <section aria-label="Example service">
      <input aria-label="draft" value={draft} onChange={event => setDraft(event.target.value)} />
      <button onClick={() => setConnected(!connected)}>Toggle connection</button>
    </section>
  </AiServiceSlot>;
}
it("places services by state while retaining controller edits across moves", () => {
  render(<AiServicesLayout><Service /></AiServicesLayout>);
  expect(within(screen.getByTestId("ai-services-available")).getByRole("region", { name: "Example service" })).toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "unsaved draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Toggle connection" }));
  expect(within(screen.getByTestId("ai-services-connected")).getByRole("region", { name: "Example service" })).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("unsaved draft");
  fireEvent.click(screen.getByRole("button", { name: "Toggle connection" }));
  expect(screen.getByRole("textbox")).toHaveValue("unsaved draft");
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";

describe("shared foundation behavior", () => {
  it("keeps each existing button variant keyboard operable and disabled actions inert", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<>
      {(["default", "secondary", "outline", "ghost", "destructive", "link"] as const).map(variant =>
        <Button key={variant} variant={variant} onClick={onClick}>{variant}</Button>)}
      <Button disabled aria-busy="true" onClick={onClick}>Saving</Button>
    </>);
    for (const variant of ["default", "secondary", "outline", "ghost", "destructive", "link"]) {
      await user.tab();
      expect(screen.getByRole("button", { name: variant })).toHaveFocus();
      await user.keyboard("{Enter}");
    }
    expect(onClick).toHaveBeenCalledTimes(6);
    await user.click(screen.getByRole("button", { name: "Saving" }));
    expect(onClick).toHaveBeenCalledTimes(6);
    expect(screen.getByRole("button", { name: "Saving" })).toBeDisabled();
  });

  it("retains form validation associations, text entry and disabled tab order", async () => {
    function Harness() {
      const form = useForm({ defaultValues: { title: "" } });
      return <Form {...form}><form onSubmit={form.handleSubmit(vi.fn())}>
        <FormField control={form.control} name="title" rules={{ required: "请输入标题 / Title required" }} render={({ field }) =>
          <FormItem><FormLabel>标题 / Title</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>} />
        <Textarea aria-label="Notes" disabled defaultValue="unchanged" />
        <Input aria-label="Disabled" disabled />
        <Select disabled><SelectTrigger aria-label="Disabled select"><SelectValue placeholder="Choose" /></SelectTrigger></Select>
        <Button type="submit">Save</Button>
      </form></Form>;
    }
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    const input = screen.getByRole("textbox", { name: "标题 / Title" });
    expect(input).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("请输入标题 / Title required")).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("请输入标题 / Title required");
    await user.type(input, "合成数据 Synthetic");
    expect(input).toHaveValue("合成数据 Synthetic");
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "ignored");
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("unchanged");
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("announces error content without truncating long bilingual titles", () => {
    const title = "加载失败 / Unable to load " + "long-title-".repeat(20);
    render(<Alert variant="destructive"><AlertTitle>{title}</AlertTitle><AlertDescription>Retry / 重试</AlertDescription></Alert>);
    expect(screen.getByRole("alert")).toHaveTextContent(title);
    expect(screen.getByRole("alert")).toHaveTextContent("Retry / 重试");
  });
});

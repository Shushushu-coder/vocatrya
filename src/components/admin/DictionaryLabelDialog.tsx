"use client";
import { useEffect, useMemo, useTransition } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Loader } from "lucide-react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../ui/form";
import { Input } from "../ui/input";
import { toastSuccess, toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";

export type DictionarySubmitResult = {
  success: boolean;
  message?: string;
};

type DictionaryLabelDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  fieldLabel: string;
  placeholder?: string;
  /** Prefilled label for the edit path; create passes "" or undefined. */
  initialLabel?: string;
  maxLength?: number;
  submit: (label: string) => Promise<DictionarySubmitResult | undefined>;
  onSaved: () => void;
};

/**
 * Shared add/rename dialog for single-label dictionary entries (job title,
 * location, source, skill tag, activity type). On failure the dialog stays
 * open with the draft intact so the user can retry; nothing clears the input.
 */
function DictionaryLabelDialog({
  open,
  onOpenChange,
  title,
  fieldLabel,
  placeholder,
  initialLabel,
  maxLength = 100,
  submit,
  onSaved,
}: DictionaryLabelDialogProps) {
  const { t } = useI18n();
  const [isPending, startTransition] = useTransition();

  const schema = useMemo(
    () =>
      z.object({
        label: z
          .string({ error: "Label is required." })
          .trim()
          .min(1, { message: "Label cannot be empty." })
          .max(maxLength, {
            message: `Label must be ${maxLength} characters or fewer.`,
          }),
      }),
    [maxLength],
  );

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { label: initialLabel ?? "" },
  });
  const { reset } = form;

  // Reopen seeds the draft from the row being edited (or empty for create).
  useEffect(() => {
    if (open) reset({ label: initialLabel ?? "" });
  }, [open, initialLabel, reset]);

  const onSubmit = (values: z.infer<typeof schema>) => {
    startTransition(async () => {
      let res: DictionarySubmitResult | undefined;
      try {
        res = await submit(values.label.trim());
      } catch {
        toastError(t("common.saveFailed"));
        return;
      }
      if (res?.success) {
        toastSuccess(t("common.saved"));
        onOpenChange(false);
        reset({ label: "" });
        onSaved();
      } else {
        toastError(res?.message ?? t("common.saveFailed"));
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{fieldLabel}</FormLabel>
                  <FormControl>
                    <Input
                      disabled={isPending}
                      placeholder={placeholder}
                      {...field}
                      onKeyDown={(e) => {
                        // IME Enter must not submit half-composed text.
                        if (
                          e.key === "Enter" &&
                          (e.nativeEvent.isComposing || e.keyCode === 229)
                        ) {
                          e.preventDefault();
                        }
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={isPending}
                onClick={() => onOpenChange(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={isPending}>
                {t("common.save")}
                {isPending && (
                  <Loader className="ml-2 h-4 w-4 shrink-0 spinner" />
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default DictionaryLabelDialog;

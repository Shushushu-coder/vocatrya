"use client";
import { useTransition, useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Loader, PlusCircle } from "lucide-react";
import { useI18n } from "@/i18n";
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
import { toastActionResult } from "@/lib/toast";
import { createContactRole } from "@/actions/contactRole.actions";

const AddContactRoleFormSchema = z.object({
  label: z
    .string({ error: "Role name is required." })
    .min(1, { message: "Role name cannot be empty." })
    .max(60, { message: "Role name must be 60 characters or fewer." }),
});

type AddContactRoleProps = {
  reloadRoles: () => void;
};

function AddContactRole({ reloadRoles }: AddContactRoleProps) {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const form = useForm<z.infer<typeof AddContactRoleFormSchema>>({
    resolver: zodResolver(AddContactRoleFormSchema),
    defaultValues: { label: "" },
  });

  const { reset } = form;

  const openDialog = () => {
    reset();
    setDialogOpen(true);
  };

  const onSubmit = (values: z.infer<typeof AddContactRoleFormSchema>) => {
    startTransition(async () => {
      const res = await createContactRole(values.label);
      toastActionResult(res, {
        success: t("library.roleAdded"),
        onSuccess: () => {
          setDialogOpen(false);
          reset();
          reloadRoles();
        },
      });
    });
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1"
        onClick={openDialog}
      >
        <PlusCircle className="h-3.5 w-3.5" />
        <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
          {t("library.newRole")}
        </span>
      </Button>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("library.addNewContactRole")}</DialogTitle>
            <DialogDescription>
              {t("library.addRoleDescription")}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="label"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("library.roleName")}</FormLabel>
                    <FormControl>
                      <Input placeholder={t("library.rolePlaceholder")} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
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
    </>
  );
}

export default AddContactRole;

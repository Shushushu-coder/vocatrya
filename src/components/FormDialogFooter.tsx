import { DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Loader } from "lucide-react";
import { useI18n } from "@/i18n";

type FormDialogFooterProps = {
  onCancel: () => void;
  isPending: boolean;
  saveDisabled: boolean;
};

// Shared Cancel/Save footer for form dialogs laid out as a 2-col grid form
export function FormDialogFooter({
  onCancel,
  isPending,
  saveDisabled,
}: FormDialogFooterProps) {
  const { t } = useI18n();

  return (
    <div className="md:col-span-2 mt-4">
      <DialogFooter>
        <div>
          <Button
            type="reset"
            variant="outline"
            className="mt-2 md:mt-0 w-full"
            onClick={onCancel}
          >
            {t("common.cancel")}
          </Button>
        </div>
        <Button type="submit" disabled={saveDisabled}>
          {t("common.save")}
          {isPending && <Loader className="h-4 w-4 shrink-0 spinner ml-1" />}
        </Button>
      </DialogFooter>
    </div>
  );
}

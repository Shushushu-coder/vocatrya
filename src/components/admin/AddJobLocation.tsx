"use client";
import { useState } from "react";
import { Button } from "../ui/button";
import { PlusCircle } from "lucide-react";
import { createLocation } from "@/actions/job.actions";
import DictionaryLabelDialog from "./DictionaryLabelDialog";
import { useI18n } from "@/i18n";

type AddJobLocationProps = {
  reloadJobLocations: () => void;
};

function AddJobLocation({ reloadJobLocations }: AddJobLocationProps) {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1"
        onClick={() => setDialogOpen(true)}
        data-testid="add-job-location-btn"
      >
        <PlusCircle className="h-3.5 w-3.5" />
        <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
          {t("common.add")} {t("library.jobLocationItem")}
        </span>
      </Button>
      <DictionaryLabelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={`${t("common.add")} ${t("library.jobLocationItem")}`}
        fieldLabel={t("common.name")}
        submit={async (label) => {
          const res = await createLocation(label);
          return {
            success: res?.success === true,
            message: res?.message,
          };
        }}
        onSaved={reloadJobLocations}
      />
    </>
  );
}

export default AddJobLocation;

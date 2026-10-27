"use client";
import { useState } from "react";
import { Button } from "../ui/button";
import { PlusCircle } from "lucide-react";
import { createJobTitle } from "@/actions/jobtitle.actions";
import DictionaryLabelDialog from "./DictionaryLabelDialog";
import { useI18n } from "@/i18n";

type AddJobTitleProps = {
  reloadJobTitles: () => void;
};

function AddJobTitle({ reloadJobTitles }: AddJobTitleProps) {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1"
        onClick={() => setDialogOpen(true)}
        data-testid="add-job-title-btn"
      >
        <PlusCircle className="h-3.5 w-3.5" />
        <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
          {t("common.add")} {t("library.jobTitleItem")}
        </span>
      </Button>
      <DictionaryLabelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={`${t("common.add")} ${t("library.jobTitleItem")}`}
        fieldLabel={t("common.name")}
        submit={async (label) => {
          // createJobTitle returns the upserted entity or a failure object.
          const res = await createJobTitle(label);
          return res?.id
            ? { success: true }
            : { success: false, message: res?.message };
        }}
        onSaved={reloadJobTitles}
      />
    </>
  );
}

export default AddJobTitle;

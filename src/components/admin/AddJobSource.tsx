"use client";
import { useState } from "react";
import { Button } from "../ui/button";
import { PlusCircle } from "lucide-react";
import { createJobSource } from "@/actions/job.actions";
import DictionaryLabelDialog from "./DictionaryLabelDialog";
import { useI18n } from "@/i18n";
import { APP_CONSTANTS } from "@/lib/constants";

type AddJobSourceProps = {
  reloadJobSources: () => void;
};

function AddJobSource({ reloadJobSources }: AddJobSourceProps) {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1"
        onClick={() => setDialogOpen(true)}
        data-testid="add-job-source-btn"
      >
        <PlusCircle className="h-3.5 w-3.5" />
        <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
          {t("common.add")} {t("library.jobSourceItem")}
        </span>
      </Button>
      <DictionaryLabelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={`${t("common.add")} ${t("library.jobSourceItem")}`}
        fieldLabel={t("common.name")}
        maxLength={APP_CONSTANTS.MAX_JOB_SOURCE_LABEL_LENGTH}
        submit={async (label) => {
          const res = await createJobSource(label);
          return {
            success: res?.success === true,
            message: res?.message,
          };
        }}
        onSaved={reloadJobSources}
      />
    </>
  );
}

export default AddJobSource;

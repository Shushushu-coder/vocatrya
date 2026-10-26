"use client";

import { Check, ChevronsUpDown, CirclePlus, Loader } from "lucide-react";
import { ControllerRenderProps } from "react-hook-form";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { FormControl } from "@/components/ui/form";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useState, useTransition } from "react";
import { createLocation } from "@/actions/job.actions";
import { JobForm } from "@/models/job.model";
import { addCompany } from "@/actions/company.actions";
import { createJobTitle } from "@/actions/jobtitle.actions";
import { toastError } from "@/lib/toast";
import { createActivityType } from "@/actions/activity.actions";
import { createJobSource } from "@/actions/job.actions";
import { createContactRole } from "@/actions/contactRole.actions";
import { useI18n } from "@/i18n";
import { APP_CONSTANTS } from "@/lib/constants";
import { canonicalizeEntityValue } from "@/lib/jobs/canonicalize";
import { resolveJobSourceIdentity } from "@/lib/jobs/jobSources";

interface ComboboxProps {
  options: any[];
  field: ControllerRenderProps<any, any>;
  creatable?: boolean;
  freeText?: boolean;
  label?: string;
  onSearchChange?: (search: string) => void;
  getOptionLabel?: (option: any) => string;
  // Opt out of the default fixed trigger width when the field sits in a grid
  fullWidth?: boolean;
}

export function Combobox({
  options,
  field,
  creatable,
  freeText,
  label,
  onSearchChange,
  getOptionLabel = (option) => option.label,
  fullWidth,
}: ComboboxProps) {
  const { t } = useI18n();
  // Placeholder text only; the accessible name comes from FormLabel/FormControl.
  // A provided label is a localized noun. Callers that omit it keep the
  // historical English field-name placeholder so unrelated screens stay put.
  const displayName = label ?? field.name;
  const closedPlaceholder = label
    ? t("common.selectName", { name: label })
    : `Select ${field.name}`;
  const [newOption, setNewOption] = useState<string>("");
  const [isPopoverOpen, setIsPopoverOpen] = useState<boolean>(false);
  // Records created through this picker. `options` is a prop — the unshift
  // into it below only survives while the parent keeps the same array, so
  // the local copy is what guarantees the new entry stays visible/selected.
  const [createdOptions, setCreatedOptions] = useState<any[]>([]);

  const [isPending, startTransition] = useTransition();
  // Sibling pickers can add to the same options array without replacing it.
  // Recompute on render so reopening a picker includes those new records.
  const allOptions = (() => {
    const seen = new Set<string>();
    const merged: any[] = [];
    for (const option of [...createdOptions, ...options]) {
      if (!option?.id || seen.has(option.id)) continue;
      seen.add(option.id);
      merged.push(option);
    }
    return merged;
  })();
  const selectedOption = allOptions.find((option) => option.id === field.value);
  const handleEnterKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;

    // Scope to this Command; a global query matches other mounted cmdk lists
    const hasHighlightedItem = !!e.currentTarget
      .closest("[cmdk-root]")
      ?.querySelector('[cmdk-item][aria-selected="true"]');

    if (hasHighlightedItem) return;

    if (!creatable) return;

    const label = newOption.trim();
    if (!label) return;

    e.preventDefault();
    onCreateOption(label);
    setNewOption("");
  };
  // Mirrors the server-side match key per field, so a typed label that would
  // resolve to an existing row selects it instead of creating a duplicate.
  // Stored `value` columns are the canonical identity; when a row's value is
  // not derivable (legacy/seeded data), the server remains authoritative.
  const canonicalInputForField = (label: string): string => {
    switch (field.name) {
      case "company":
      case "workedAtCompany":
        return canonicalizeEntityValue(label, { stripLegalSuffix: true });
      case "source": {
        const identity = resolveJobSourceIdentity(
          label,
          APP_CONSTANTS.MAX_JOB_SOURCE_LABEL_LENGTH,
        );
        return "error" in identity ? "" : identity.value;
      }
      case "activityType":
        // createActivityType keys on label.trim().toLowerCase(), not the
        // shared canonicalizer used by the other entities.
        return label.toLowerCase();
      default:
        return canonicalizeEntityValue(label);
    }
  };

  const onCreateOption = (rawLabel: string) => {
    const label = rawLabel.trim();
    // CommandEmpty's click path reaches here even without `creatable`.
    if (!creatable || !label || isPending || field.disabled) return;
    // A free-text field has no reference record behind it — the typed text is
    // itself the stored value, so there is nothing to create server-side.
    if (freeText) {
      field.onChange(label);
      setIsPopoverOpen(false);
      return;
    }
    const canonical = canonicalInputForField(label);
    const resolved = canonical
      ? allOptions.find((option) => option.value === canonical)
      : undefined;
    if (resolved) {
      field.onChange(resolved.id);
      setIsPopoverOpen(false);
      return;
    }
    startTransition(async () => {
      // The six create actions return four different shapes — normalize them
      // all to a record-or-message pair before touching the form value.
      let record: any;
      let message: string | undefined;
      let supported = true;
      try {
        switch (field.name) {
          case "company":
          case "workedAtCompany": {
            const res = await addCompany({ company: label });
            if (res?.success) record = res.data;
            else message = res?.message;
            break;
          }
          case "title": {
            const res = await createJobTitle(label);
            if (res?.id) record = res;
            else message = res?.message;
            break;
          }
          case "location": {
            const res = await createLocation(label);
            if (res?.success) record = res.data;
            else message = res?.message;
            break;
          }
          case "source": {
            const res = await createJobSource(label);
            if (res?.success) record = res.data;
            else message = res?.message;
            break;
          }
          case "contactRole": {
            const res = await createContactRole(label);
            if (res?.success) record = res.data;
            else message = res?.message;
            break;
          }
          case "activityType": {
            // Unlike the others this action throws rather than returning a
            // failure object — the surrounding catch turns it into a toast.
            const res = await createActivityType(label);
            if (res?.id) record = res;
            break;
          }
          default:
            supported = false;
        }
      } catch (err) {
        message = err instanceof Error ? err.message : undefined;
      }
      if (!supported) {
        toastError(
          t("basicDataInline.createUnsupported", { name: displayName }),
        );
        return;
      }
      if (!record?.id) {
        toastError(
          message ?? t("basicDataInline.createFailed", { name: displayName }),
        );
        return;
      }
      setCreatedOptions((prev) =>
        prev.some((option) => option.id === record.id) ? prev : [record, ...prev],
      );
      // Sibling pickers share the parent's options array; keep them in sync
      // too, but never insert a second copy of the resolved record.
      if (!options.some((option) => option.id === record.id)) {
        options.unshift(record);
      }
      field.onChange(record.id);
      setIsPopoverOpen(false);
    });
  };

  return (
    <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen} modal>
      <PopoverTrigger asChild>
        <FormControl>
          <Button
            type="button"
            disabled={field.disabled || isPending}
            aria-busy={isPending}
            onBlur={field.onBlur}
            ref={field.ref}
            variant="outline"
            role="combobox"
            className={cn(
              "justify-between",
              fullWidth ? "w-full" : "md:w-[240px] lg:w-[280px]",
              !field.value && "text-muted-foreground"
            )}
          >
            <span className="min-w-0 truncate">
              {field.value
                ? (selectedOption ? getOptionLabel(selectedOption) : (freeText ? field.value : null))
                : closedPlaceholder}
            </span>

            {isPending ? (
              <Loader className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />
            ) : (
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            )}
          </Button>
        </FormControl>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          "p-0",
          fullWidth
            ? "w-(--radix-popover-trigger-width)"
            : "md:w-[240px] lg:w-[280px]"
        )}
      >
        <Command
          filter={(value, search) =>
            value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput
            disabled={isPending || field.disabled}
            value={newOption}
            onValueChange={(val: string) => {
              setNewOption(val);
              onSearchChange?.(val);
            }}
            placeholder={
              creatable
                ? t("common.createOrSearch", { name: displayName })
                : t("common.searchName", { name: displayName })
            }
            onKeyDown={(e) => handleEnterKey(e)}
          />
          <CommandList>
            <CommandEmpty
              onClick={() => {
                onCreateOption(newOption);
                setNewOption("");
              }}
              className={cn(
                "flex cursor-pointer items-center justify-center gap-1 italic mt-2",
                !newOption && "text-muted-foreground cursor-default"
              )}
            >
              {creatable ? (
                <>
                  <CirclePlus className="h-4 w-4" />
                  <p>{t("common.createPrefix")} </p>
                  <p className="block max-w-48 truncate font-semibold text-primary">
                    {newOption}
                  </p>
                </>
              ) : (
                <p className="font-semibold text-primary">{t("common.noSourceFound")}</p>
              )}
            </CommandEmpty>
            <CommandGroup>
              {allOptions.map((option) => (
                <CommandItem
                  disabled={isPending || field.disabled}
                  value={`${getOptionLabel(option)} ${option.value}`}
                  key={option.id}
                  onSelect={() => {
                    if (field.onChange) {
                      field.onChange(option.id);
                      setIsPopoverOpen(false);
                    }
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      option.id === field.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  {getOptionLabel(option)}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

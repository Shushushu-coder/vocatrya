"use client";

import React from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { FormControl } from "./ui/form";
import { ControllerRenderProps } from "react-hook-form";
import { useI18n } from "@/i18n";

interface SelectProps {
  label: string;
  options: any[];
  field: ControllerRenderProps<any, any>;
}

function SelectFormCtrl({ label, options, field }: SelectProps) {
  const { t } = useI18n();
  const selectLabel = t("common.selectName", { name: label });
  return (
    <>
      <Select
        onValueChange={field.onChange}
        value={field.value}
        name={field.name}
      >
        <FormControl>
          <SelectTrigger aria-label={selectLabel} className="w-[200px]">
            <SelectValue placeholder={selectLabel} />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          <SelectGroup>
            {options &&
              options.map((option) => {
                return (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label ?? option.value ?? option.title}
                  </SelectItem>
                );
              })}
          </SelectGroup>
        </SelectContent>
      </Select>
    </>
  );
}

export default SelectFormCtrl;

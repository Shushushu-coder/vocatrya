"use client";

import { addDays } from "date-fns";
import { useI18n } from "@/i18n";
import { Calendar as CalendarIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ControllerRenderProps } from "react-hook-form";
import { useState } from "react";
import { FormControl } from "./ui/form";

interface DatePickerProps {
  field: ControllerRenderProps<any, any>;
  presets: boolean;
  isEnabled: boolean;
  captionLayout?: boolean;
  // Opt out of the default fixed trigger width when the field sits in a grid
  fullWidth?: boolean;
  disableFuture?: boolean;
}

export function DatePicker({
  field,
  presets,
  isEnabled,
  captionLayout,
  fullWidth,
  disableFuture,
}: DatePickerProps) {
  const { t, formatDate } = useI18n();
  const [isPopoverOpen, setIsPopoverOpen] = useState<boolean>(false);

  return (
    <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
      <PopoverTrigger asChild>
        <FormControl>
          <Button
            variant={"outline"}
            className={cn(
              "justify-start text-left font-normal",
              fullWidth ? "w-full" : "md:w-[240px] lg:w-[280px]",
              !field.value && "text-muted-foreground"
            )}
            disabled={!isEnabled}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {field.value ? formatDate(field.value) : <span>{t("common.pickDate")}</span>}
          </Button>
        </FormControl>
      </PopoverTrigger>
      <PopoverContent className="flex w-auto flex-col space-y-2 p-2">
        {presets && (
          <Select
            onValueChange={(value) => {
              field.onChange(addDays(new Date(), parseInt(value)));
              setIsPopoverOpen(false);
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={t("common.selectPreset")} />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="0">{t("common.today")}</SelectItem>
              <SelectItem value="1">{t("common.tomorrow")}</SelectItem>
              <SelectItem value="3">{t("common.in3Days")}</SelectItem>
              <SelectItem value="7">{t("common.inAWeek")}</SelectItem>
            </SelectContent>
          </Select>
        )}
        <Calendar
          mode="single"
          captionLayout={captionLayout ? "dropdown" : "label"}
          startMonth={captionLayout ? new Date(1970, 0) : undefined}
          endMonth={captionLayout ? new Date() : undefined}
          selected={field.value}
          disabled={disableFuture ? { after: new Date() } : undefined}
          onSelect={(value) => {
            field.onChange(value);
            setIsPopoverOpen(false);
          }}
          className="rounded-md border"
          //   disabled={(date) =>
          //     field.value > new Date() || field.value < new Date("1900-01-01")
          //   }
          // initialFocus // NOTE: Enabling this cause error in safari browser
        />
      </PopoverContent>
    </Popover>
  );
}

"use client";

/**
 * SET-INPUT-PREFERENCES: thin wrappers around the plain ui controls used by
 * multi-field edit forms (referee / ID document / emergency contact / material
 * create / evidence). They attach the shared data attribute and per-field
 * keyboard, entry-selection and hint behavior without touching form logic:
 * caller handlers still run, and Enter navigation is consumed before them.
 */
import { useState } from "react";
import { useI18n } from "@/i18n";
import { Input, type InputProps } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useStructuredField } from "@/lib/inputPreferences";

type StructuredControlProps = {
  multiline?: boolean;
  validate?: (value: string) => boolean;
  /** Optional gate for Enter→next (e.g. required-but-empty stays focused). */
  canLeave?: () => boolean;
  onLeaveBlocked?: () => void;
};

// The control and its hint share one wrapper so the pair still occupies a
// single slot inside row layouts (e.g. the evidence metric row).
const WRAPPER_CLASS = "flex min-w-0 flex-1 flex-col gap-1";

export function StructuredInput({
  multiline,
  validate,
  canLeave,
  onLeaveBlocked,
  ...props
}: InputProps & StructuredControlProps) {
  const { t } = useI18n();
  const [blocked, setBlocked] = useState(false);
  const valid = () =>
    (!props.required || String(props.value ?? "").trim().length > 0) &&
    (!validate || validate(String(props.value ?? ""))) &&
    (!canLeave || canLeave());
  const structured = useStructuredField({
    multiline,
    canLeave: valid,
    onLeaveBlocked: () => {
      setBlocked(true);
      onLeaveBlocked?.();
    },
  });
  return (
    <div className={WRAPPER_CLASS}>
      <Input
        {...props}
        {...structured.bind}
        onFocus={(e) => {
          structured.bind.onFocus(e);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          structured.bind.onBlur(e);
          setBlocked(!valid());
          props.onBlur?.(e);
        }}
        onMouseDown={(e) => {
          structured.bind.onMouseDown(e);
          props.onMouseDown?.(e);
        }}
        onChange={(e) => {
          setBlocked(false);
          props.onChange?.(e);
        }}
        onKeyDown={(e) => {
          if (!structured.bind.onKeyDown(e)) props.onKeyDown?.(e);
        }}
      />
      {blocked && (
        <div role="alert" className="text-xs text-destructive">
          {t(props.required && !String(props.value ?? "").trim()
            ? "inputPrefs.fieldRequired"
            : "inputPrefs.invalidField")}
        </div>
      )}
    </div>
  );
}

export function StructuredTextarea({
  canLeave,
  onLeaveBlocked,
  ...props
}: React.ComponentProps<"textarea"> & StructuredControlProps) {
  const structured = useStructuredField({
    multiline: true,
    canLeave,
    onLeaveBlocked,
  });
  return (
    <div className={WRAPPER_CLASS}>
      <Textarea
        {...props}
        {...structured.bind}
        onFocus={(e) => {
          structured.bind.onFocus(e);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          structured.bind.onBlur(e);
          props.onBlur?.(e);
        }}
        onMouseDown={(e) => {
          structured.bind.onMouseDown(e);
          props.onMouseDown?.(e);
        }}
        onKeyDown={(e) => {
          if (!structured.bind.onKeyDown(e)) props.onKeyDown?.(e);
        }}
      />
    </div>
  );
}

/** Plain-checkbox wrapper: joins the navigation chain without a hint row. */
export function StructuredCheckbox({
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  const structured = useStructuredField();
  return (
    <input
      type="checkbox"
      {...props}
      {...structured.bind}
      onFocus={(e) => {
        structured.bind.onFocus(e);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        structured.bind.onBlur(e);
        props.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (!structured.bind.onKeyDown(e)) props.onKeyDown?.(e);
      }}
    />
  );
}

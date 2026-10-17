import * as React from "react"

import { controlStyles } from "@/components/ui/control-styles"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        controlStyles,
        "flex field-sizing-content min-h-16 w-full px-3 py-2",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }

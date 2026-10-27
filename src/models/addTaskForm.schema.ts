import { z } from "zod";

export const AddTaskFormSchema = z.object({
  id: z.string().optional(),
  userId: z.string().optional(),
  title: z
    .string({ error: "Title is required." })
    .min(2, { message: "Title must be at least 2 characters." }),
  description: z
    .string()
    .max(2000, { message: "Description cannot exceed 2000 characters." })
    .optional()
    .nullable(),
  status: z.enum(["in-progress", "complete", "needs-attention", "cancelled"]),
  priority: z.number().min(0).max(10),
  percentComplete: z.number().min(0).max(100),
  // Picker carrier only: the form binds its Date here; the write contract is
  // `dueOn` below, and actions ignore this field.
  dueDate: z.date().optional().nullable(),
  // Due write contract: absent = field untouched (update keeps stored values),
  // null = explicit clear, "YYYY-MM-DD" = set a calendar-day due (dateOnly).
  dueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "Invalid due date." })
    .optional()
    .nullable(),
  activityTypeId: z.string().optional().nullable(),
});

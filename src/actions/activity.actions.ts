// Barrel for the task-category (ActivityType) server actions. The activity
// product was retired; this path stays so existing "@/actions/activity.actions"
// imports keep working without churn across callers.

export {
  getAllActivityTypes,
  createActivityType,
  updateActivityType,
  getActivityTypeList,
  deleteActivityTypeById,
} from "./activity/activityTypes";

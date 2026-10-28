-- Drop the retired job-activity time-tracking table. Task categorization via
-- Task.activityTypeId -> ActivityType is unaffected and remains in place.
DROP TABLE "Activity";

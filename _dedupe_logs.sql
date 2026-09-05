-- Delete duplicate log entries: keep only the newest row per
-- (deviceId, hostname, timestamp, message). The worker re-runs GET_LOGS
-- every 5 minutes and the same auth.log line gets inserted each time,
-- so the logs page is full of churn. After this runs once the worker
-- dedup (in persistLogsForJob) will prevent new duplicates.

DELETE FROM "DeviceLog" AS d
USING "DeviceLog" AS keep
WHERE keep."deviceId" = d."deviceId"
  AND keep.hostname = d.hostname
  AND keep.timestamp = d.timestamp
  AND keep.message = d.message
  AND keep."receivedAt" > d."receivedAt"
  AND d.id <> keep.id;

SELECT COUNT(*) AS remaining_rows FROM "DeviceLog";

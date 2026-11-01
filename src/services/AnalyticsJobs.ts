import JobService from "./JobService";
import MetricsDailyService from "./admin/MetricsDailyService";

export function registerAnalyticsJobs() {
  JobService.register("analytics:metrics-daily", async () => {
    const day = MetricsDailyService.yesterdayUtc();
    return MetricsDailyService.snapshot(day);
  });
}

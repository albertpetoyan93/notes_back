import JobService from "./JobService";
import TrafficService from "./TrafficService";
import MetricsDailyService from "./admin/MetricsDailyService";

export function registerAnalyticsJobs() {
  JobService.register("analytics:metrics-daily", async () => {
    const day = MetricsDailyService.yesterdayUtc();
    return MetricsDailyService.snapshot(day);
  });
  // Deletes yesterday-minus-one salts so old visitor hashes can never be matched again.
  JobService.register("analytics:traffic-cleanup", () => TrafficService.cleanup());
}

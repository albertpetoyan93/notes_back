import AnnouncementService from "./AnnouncementService";
import JobService from "./JobService";
import BreachDigestService from "./BreachDigestService";
import BreachFeedService from "./BreachFeedService";
import TrafficService from "./TrafficService";
import MetricsDailyService from "./admin/MetricsDailyService";

export function registerAnalyticsJobs() {
  JobService.register("analytics:metrics-daily", async () => {
    const day = MetricsDailyService.yesterdayUtc();
    return MetricsDailyService.snapshot(day);
  });
  // Deletes yesterday-minus-one salts so old visitor hashes can never be matched again.
  JobService.register("analytics:traffic-cleanup", () => TrafficService.cleanup());
  // The public list of breached websites for breach alerts (docs/features/breach-alerts.md).
  JobService.register("security:breach-feed", () => BreachFeedService.job());
  // The opt-in weekly breach email (phase 3); runs daily, sends to whoever is due, capped per day.
  JobService.register("security:breach-digest", () => BreachDigestService.run());
  // Product announcements to existing users in daily batches; off unless ANNOUNCEMENT names one.
  JobService.register("marketing:announcement", () => AnnouncementService.run());
}

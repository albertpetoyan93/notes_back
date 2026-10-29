import logger from "jet-logger";
import { QueryTypes } from "sequelize";
import sequelize from "../configs/DB/sequelize";

type Job = { name: string; run: () => Promise<unknown> };

const HOUR_MS = 60 * 60 * 1000;

/**
 * Jobs that run once a day inside the backend process. Every hour it checks whether
 * today's run already happened; claiming a day is one UPDATE, so a restart or a second
 * process never runs the same job twice on one day.
 */
class JobService {
  private jobs: Job[] = [];
  private timer: NodeJS.Timeout | null = null;

  register(name: string, run: () => Promise<unknown>) {
    this.jobs.push({ name, run });
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), HOUR_MS);
    // Never keeps the process alive on its own (clean shutdowns).
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** True when this call got today's run of the job. */
  async claim(name: string) {
    const rows = await sequelize.query(
      `INSERT INTO "job_runs" ("name", "lastRunDay", "lastRunAt")
       VALUES (:name, CURRENT_DATE, NOW())
       ON CONFLICT ("name") DO UPDATE
         SET "lastRunDay" = CURRENT_DATE, "lastRunAt" = NOW(), "lastError" = NULL
         WHERE "job_runs"."lastRunDay" IS NULL OR "job_runs"."lastRunDay" < CURRENT_DATE
       RETURNING "name"`,
      { replacements: { name }, type: QueryTypes.SELECT }
    );
    return rows.length > 0;
  }

  async tick() {
    for (const job of this.jobs) {
      try {
        if (!(await this.claim(job.name))) continue;
        const result = await job.run();
        logger.info(`job ${job.name}: ${JSON.stringify(result ?? "done")}`);
      } catch (error: any) {
        logger.err(`job ${job.name} failed: ${error?.message || error}`);
        await sequelize
          .query(`UPDATE "job_runs" SET "lastError" = :error WHERE "name" = :name`, {
            replacements: { name: job.name, error: String(error?.message || error).slice(0, 2000) },
          })
          .catch(() => undefined);
      }
    }
  }
}

export default new JobService();

import EmailVerificationService from "./EmailVerificationService";
import JobService from "./JobService";

/** Daily: accounts that never confirmed their address within 7 days and have nothing are removed. */
export function registerEmailVerificationJobs() {
  JobService.register("accounts:purge-unconfirmed", async () => ({
    removed: await EmailVerificationService.purgeUnconfirmed(),
  }));
}

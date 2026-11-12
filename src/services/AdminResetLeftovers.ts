import User from "../models/User";
import EmailService from "./EmailService";
import NotificationService from "./NotificationService";

/**
 * Leftovers of the old "company admin recovery" (removed 11 Nov 2026, ADR-001):
 * accounts whose master password a company admin set and who haven't chosen
 * their own since. That admin still knows a password that opens their whole
 * vault, personal items included. They are asked to change it now.
 */
const NOTICE =
  "Your master password was set by a company admin and still is. Choose your own now in Settings → Security, so nobody else knows it.";

class AdminResetLeftovers {
  async list() {
    const users = await User.findAll({ where: { mustChangeMasterPassword: true }, attributes: ["id", "email"] });
    return users.map((user) => ({ id: user.id, email: user.email }));
  }

  /** Dry run unless `notify`: only counts them. */
  async run({ notify }: { notify: boolean }) {
    const people = await this.list();
    let notified = 0;
    if (notify) {
      for (const person of people) {
        await NotificationService.create(person.id, NOTICE).catch(() => undefined);
        await EmailService.sendSecurityNotice({ to: person.email, what: NOTICE }).catch(() => undefined);
        notified += 1;
      }
    }
    return { found: people.length, notified };
  }
}

export default new AdminResetLeftovers();

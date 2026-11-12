import { Op } from "sequelize";
import CompanyMember from "../models/CompanyMember";
import User from "../models/User";
import EmailService from "./EmailService";
import NotificationService from "./NotificationService";

/**
 * Vault recovery notices: the company's owners plus the given people (its
 * custodians, someone removed as one, the person who got access), in the app
 * and by email. Never with reasons, keys or secrets. Failures don't stop the
 * action that was taken.
 */
export async function notifyRecovery(companyId: number, message: string, userIds: number[]) {
  const owners = await CompanyMember.findAll({ where: { companyId, status: "active", role: "owner" }, attributes: ["userId"] });
  const ids = [...new Set([...owners.map((row) => row.userId as number), ...userIds])].filter(Boolean);
  const people = ids.length ? await User.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id", "email"] }) : [];
  for (const person of people) {
    await NotificationService.create(person.id, message).catch(() => undefined);
    EmailService.sendSecurityNotice({ to: person.email, what: message }).catch(() => undefined);
  }
}

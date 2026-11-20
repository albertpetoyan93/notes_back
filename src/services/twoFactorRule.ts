import { Op } from "sequelize";
import User from "../models/User";
import UserPasskey from "../models/UserPasskey";

/**
 * Who meets a company's "require two-factor sign-in" rule (F15): an
 * authenticator app (TOTP) or at least one passkey. A passkey sign-in is both
 * factors at once and resists phishing better than codes (owner's decision, 19 Nov).
 */
export async function meetsTwoFactorRule(userIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(userIds.filter((id) => Number.isInteger(id)))];
  if (!ids.length) return new Set();
  const [withApp, withPasskey] = await Promise.all([
    User.findAll({ where: { id: { [Op.in]: ids }, twoFactorEnabled: true }, attributes: ["id"] }),
    UserPasskey.findAll({ where: { userId: { [Op.in]: ids } }, attributes: ["userId"] }),
  ]);
  return new Set([...withApp.map((user) => user.id), ...withPasskey.map((passkey) => passkey.userId)]);
}

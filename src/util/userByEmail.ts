import { FindAttributeOptions, Op } from "sequelize";
import User from "../models/User";

/**
 * The account for a typed email address. Spaces around it are ignored, and so is
 * letter case: phones often capitalise the first letter ("Bob@x.com") or add a
 * space when filling. Sign-in, its first step (prelogin) and recovery must all
 * find the same account, or the right password is refused.
 * An exact match wins, for the rare database that holds two spellings.
 */
export const userByEmail = async (email: unknown, attributes?: FindAttributeOptions) => {
  const address = String(email || "").trim();
  if (!address) return null;
  return (
    (await User.findOne({ where: { email: address }, attributes })) ||
    // Escaped: a % or _ typed in the email must not match someone else's address.
    (await User.findOne({ where: { email: { [Op.iLike]: address.replace(/[\\%_]/g, "\\$&") } }, attributes }))
  );
};

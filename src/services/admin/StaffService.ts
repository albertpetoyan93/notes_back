import { Op, UniqueConstraintError, fn, col, where } from "sequelize";
import AdminStaff, { StaffRole } from "../../models/AdminStaff";
import User from "../../models/User";
import { adminEmails, isAdminEmail } from "../DiscountService";

export interface StaffRow {
  userId: number;
  email: string;
  name: string;
  role: StaffRole;
  addedBy: number | null;
  createdAt: Date | null;
  disabledAt: Date | null;
  /** In ADMIN_EMAILS: always admin, changed only through the env. */
  fromEnv: boolean;
}

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

const byEmail = (email: string) => where(fn("lower", col("email")), email.trim().toLowerCase());

class StaffService {
  /** admin if the email is in ADMIN_EMAILS, else the staff row's role unless disabled. */
  static async roleOf(userId: number): Promise<StaffRole | null> {
    const user = await User.findByPk(userId, { attributes: ["email"] });
    if (!user) return null;
    if (isAdminEmail(user.email)) return "admin";
    const staff = await AdminStaff.findByPk(userId);
    return staff && !staff.disabledAt ? staff.role : null;
  }

  static async list(): Promise<StaffRow[]> {
    const rows = await AdminStaff.findAll({ order: [["createdAt", "ASC"]] });
    const emails = adminEmails();
    const envUsers = emails.length
      ? await User.findAll({
          where: where(fn("lower", col("email")), { [Op.in]: emails }),
          attributes: ["id", "email", "username", "fullName"],
        })
      : [];
    const staffIds = rows.map((row) => row.userId);
    const staffUsers = staffIds.length
      ? await User.findAll({ where: { id: staffIds }, attributes: ["id", "email", "username", "fullName"] })
      : [];
    const users = new Map([...staffUsers, ...envUsers].map((user) => [user.id, user]));

    const result: StaffRow[] = [];
    const seen = new Set<number>();
    for (const user of envUsers) {
      const row = rows.find((r) => r.userId === user.id);
      seen.add(user.id);
      result.push({
        userId: user.id,
        email: user.email,
        name: user.fullName || user.username,
        role: "admin",
        addedBy: row?.addedBy ?? null,
        createdAt: row?.createdAt ?? null,
        disabledAt: null,
        fromEnv: true,
      });
    }
    for (const row of rows) {
      if (seen.has(row.userId)) continue;
      const user = users.get(row.userId);
      if (!user) continue;
      result.push({
        userId: row.userId,
        email: user.email,
        name: user.fullName || user.username,
        role: row.role,
        addedBy: row.addedBy ?? null,
        createdAt: row.createdAt,
        disabledAt: row.disabledAt ?? null,
        fromEnv: false,
      });
    }
    return result;
  }

  static async add(email: string, role: StaffRole, by: number) {
    const user = await User.findOne({ where: byEmail(email), attributes: ["id", "email"] });
    if (!user) throw fail(404, "No account has that email");
    if (isAdminEmail(user.email) || (await AdminStaff.findByPk(user.id))) {
      throw fail(409, "That user is already staff");
    }
    try {
      return await AdminStaff.create({ userId: user.id, role, addedBy: by });
    } catch (err) {
      // Two admins adding the same person at once.
      if (err instanceof UniqueConstraintError) throw fail(409, "That user is already staff");
      throw err;
    }
  }

  static async update(userId: number, change: { role?: StaffRole; disabled?: boolean }, by: number) {
    if (userId === by) throw fail(409, "You can't change your own access");
    const user = await User.findByPk(userId, { attributes: ["email"] });
    if (user && isAdminEmail(user.email)) {
      throw fail(409, "This admin is set in ADMIN_EMAILS; change the env instead");
    }
    const staff = await AdminStaff.findByPk(userId);
    if (!staff) throw fail(404, "Not a staff member");
    if (change.role) staff.role = change.role;
    if (change.disabled !== undefined) staff.disabledAt = change.disabled ? new Date() : null;
    await staff.save();
    return staff;
  }
}

export default StaffService;

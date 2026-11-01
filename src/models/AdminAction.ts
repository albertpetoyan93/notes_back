import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import type { StaffRole } from "./AdminStaff";

interface AdminActionAttributes {
  id: number;
  staffUserId?: number | null;
  /** Snapshots, so the row stays readable after the user changes or is deleted. */
  staffEmail: string;
  role?: StaffRole | null;
  action: string;
  targetUserId?: number | null;
  targetEmail?: string | null;
  targetCompanyId?: number | null;
  reason?: string | null;
  details: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  createdAt?: Date;
}

type AdminActionCreation = Optional<
  AdminActionAttributes,
  | "id"
  | "staffUserId"
  | "role"
  | "targetUserId"
  | "targetEmail"
  | "targetCompanyId"
  | "reason"
  | "details"
  | "ip"
  | "userAgent"
  | "createdAt"
>;

class AdminAction
  extends Model<AdminActionAttributes, AdminActionCreation>
  implements AdminActionAttributes
{
  public id!: number;
  public staffUserId?: number | null;
  public staffEmail!: string;
  public role?: StaffRole | null;
  public action!: string;
  public targetUserId?: number | null;
  public targetEmail?: string | null;
  public targetCompanyId?: number | null;
  public reason?: string | null;
  public details!: Record<string, unknown>;
  public ip?: string | null;
  public userAgent?: string | null;
  public readonly createdAt!: Date;
}

AdminAction.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      // Postgres returns BIGINT as a string.
      get() {
        return Number(this.getDataValue("id"));
      },
    },
    staffUserId: { type: DataTypes.INTEGER, allowNull: true },
    staffEmail: { type: DataTypes.STRING(255), allowNull: false },
    role: { type: DataTypes.STRING(20), allowNull: true },
    action: { type: DataTypes.STRING(60), allowNull: false },
    targetUserId: { type: DataTypes.INTEGER, allowNull: true },
    targetEmail: { type: DataTypes.STRING(255), allowNull: true },
    targetCompanyId: { type: DataTypes.INTEGER, allowNull: true },
    reason: { type: DataTypes.TEXT, allowNull: true },
    details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    ip: { type: DataTypes.STRING(100), allowNull: true },
    userAgent: { type: DataTypes.STRING(500), allowNull: true },
  },
  {
    sequelize,
    tableName: "admin_actions",
    timestamps: true,
    updatedAt: false,
  }
);

export default AdminAction;

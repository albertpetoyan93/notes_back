import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type StaffRole = "admin" | "support" | "marketing";

interface AdminStaffAttributes {
  userId: number;
  role: StaffRole;
  addedBy?: number | null;
  createdAt?: Date;
  disabledAt?: Date | null;
}

type AdminStaffCreation = Optional<AdminStaffAttributes, "addedBy" | "createdAt" | "disabledAt">;

class AdminStaff
  extends Model<AdminStaffAttributes, AdminStaffCreation>
  implements AdminStaffAttributes
{
  public userId!: number;
  public role!: StaffRole;
  public addedBy?: number | null;
  public readonly createdAt!: Date;
  public disabledAt?: Date | null;
}

AdminStaff.init(
  {
    userId: { type: DataTypes.INTEGER, primaryKey: true },
    role: { type: DataTypes.STRING(20), allowNull: false },
    addedBy: { type: DataTypes.INTEGER, allowNull: true },
    disabledAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    tableName: "admin_staff",
    timestamps: true,
    updatedAt: false,
  }
);

export default AdminStaff;

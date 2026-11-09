import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type OffboardingStatus = "in_progress" | "complete";

interface CompanyOffboardingAttributes {
  id: number;
  companyId: number;
  userId: number;
  /** Snapshot, so the row stays readable after the user changes. */
  memberEmail: string;
  startedBy?: number | null;
  status: OffboardingStatus;
  startedAt?: Date;
  completedAt?: Date | null;
}

type CompanyOffboardingCreation = Optional<
  CompanyOffboardingAttributes,
  "id" | "startedBy" | "status" | "startedAt" | "completedAt"
>;

class CompanyOffboarding
  extends Model<CompanyOffboardingAttributes, CompanyOffboardingCreation>
  implements CompanyOffboardingAttributes
{
  public id!: number;
  public companyId!: number;
  public userId!: number;
  public memberEmail!: string;
  public startedBy?: number | null;
  public status!: OffboardingStatus;
  public startedAt!: Date;
  public completedAt?: Date | null;
}

CompanyOffboarding.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    companyId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    memberEmail: { type: DataTypes.STRING(255), allowNull: false },
    startedBy: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "in_progress" },
    startedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    completedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    tableName: "company_offboardings",
    timestamps: false,
  }
);

export default CompanyOffboarding;

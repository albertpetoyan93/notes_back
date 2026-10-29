import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type DiscountKind = "nonprofit" | "school";
export type DiscountRequestStatus = "pending" | "approved" | "declined";

/** A company owner asking for the nonprofit or school discount (migration 041). */
interface DiscountRequestAttributes {
  id: number;
  companyId: number;
  /** Who sent it (the owner at the time). */
  userId?: number | null;
  kind: DiscountKind;
  organization: string;
  website?: string | null;
  note?: string | null;
  status: DiscountRequestStatus;
  decidedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type DiscountRequestCreation = Optional<
  DiscountRequestAttributes,
  "id" | "userId" | "website" | "note" | "status" | "decidedAt" | "createdAt" | "updatedAt"
>;

class DiscountRequest
  extends Model<DiscountRequestAttributes, DiscountRequestCreation>
  implements DiscountRequestAttributes
{
  public id!: number;
  public companyId!: number;
  public userId?: number | null;
  public kind!: DiscountKind;
  public organization!: string;
  public website?: string | null;
  public note?: string | null;
  public status!: DiscountRequestStatus;
  public decidedAt?: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

DiscountRequest.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    companyId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: true },
    kind: { type: DataTypes.STRING(16), allowNull: false },
    organization: { type: DataTypes.STRING(200), allowNull: false },
    website: { type: DataTypes.STRING(255), allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "pending" },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: "discount_requests", timestamps: true }
);

export default DiscountRequest;

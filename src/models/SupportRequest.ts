import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type SupportRequestStatus = "pending" | "confirmed" | "cancelled" | "expired";

interface SupportRequestAttributes {
  id: number;
  kind: "remove_2fa";
  userId: number;
  requestedBy: number;
  reason: string;
  tokenHash: string;
  status: SupportRequestStatus;
  expiresAt: Date;
  decidedAt?: Date | null;
  createdAt?: Date;
}

type SupportRequestCreation = Optional<
  SupportRequestAttributes,
  "id" | "status" | "decidedAt" | "createdAt"
>;

class SupportRequest
  extends Model<SupportRequestAttributes, SupportRequestCreation>
  implements SupportRequestAttributes
{
  public id!: number;
  public kind!: "remove_2fa";
  public userId!: number;
  public requestedBy!: number;
  public reason!: string;
  public tokenHash!: string;
  public status!: SupportRequestStatus;
  public expiresAt!: Date;
  public decidedAt?: Date | null;
  public readonly createdAt!: Date;
}

SupportRequest.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    kind: { type: DataTypes.STRING(30), allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    requestedBy: { type: DataTypes.INTEGER, allowNull: false },
    reason: { type: DataTypes.TEXT, allowNull: false },
    tokenHash: { type: DataTypes.STRING(64), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    tableName: "support_requests",
    timestamps: true,
    updatedAt: false,
  }
);

export default SupportRequest;

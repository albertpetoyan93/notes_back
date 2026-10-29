import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface TrialUsedAttributes {
  id: number;
  userId?: number | null;
  companyId?: number | null;
  plan: string;
  createdAt?: Date;
}

/** One trial per plan per person or company (unique indexes in migration 034). */
class TrialUsed
  extends Model<TrialUsedAttributes, Optional<TrialUsedAttributes, "id" | "userId" | "companyId" | "createdAt">>
  implements TrialUsedAttributes
{
  public id!: number;
  public userId?: number | null;
  public companyId?: number | null;
  public plan!: string;
  public readonly createdAt!: Date;
}

TrialUsed.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    userId: { type: DataTypes.INTEGER, allowNull: true },
    companyId: { type: DataTypes.INTEGER, allowNull: true },
    plan: { type: DataTypes.STRING(20), allowNull: false },
  },
  { sequelize, tableName: "trials_used", timestamps: true, updatedAt: false }
);

export default TrialUsed;

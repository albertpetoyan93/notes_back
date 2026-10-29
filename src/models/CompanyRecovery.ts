import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/**
 * Company admin recovery (migration 040). `CompanyRecoveryKey`: the company's
 * recovery private key, sealed to one owner or admin. `MemberRecovery`: one
 * member's user key, sealed to the company's recovery public key.
 */
interface CompanyRecoveryKeyAttributes {
  id: number;
  companyId: number;
  userId: number;
  keyVersion: number;
  wrappedKey: string;
}

export class CompanyRecoveryKey
  extends Model<CompanyRecoveryKeyAttributes, Optional<CompanyRecoveryKeyAttributes, "id">>
  implements CompanyRecoveryKeyAttributes
{
  public id!: number;
  public companyId!: number;
  public userId!: number;
  public keyVersion!: number;
  public wrappedKey!: string;
}

CompanyRecoveryKey.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    companyId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    keyVersion: { type: DataTypes.INTEGER, allowNull: false },
    wrappedKey: { type: DataTypes.TEXT, allowNull: false },
  },
  { sequelize, tableName: "company_recovery_keys", timestamps: true }
);

interface MemberRecoveryAttributes {
  id: number;
  companyId: number;
  userId: number;
  keyVersion: number;
  sealedUserKey: string;
}

export class MemberRecovery
  extends Model<MemberRecoveryAttributes, Optional<MemberRecoveryAttributes, "id">>
  implements MemberRecoveryAttributes
{
  public id!: number;
  public companyId!: number;
  public userId!: number;
  public keyVersion!: number;
  public sealedUserKey!: string;
}

MemberRecovery.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    companyId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    keyVersion: { type: DataTypes.INTEGER, allowNull: false },
    sealedUserKey: { type: DataTypes.TEXT, allowNull: false },
  },
  { sequelize, tableName: "company_member_recovery", timestamps: true }
);

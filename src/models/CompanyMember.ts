import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type CompanyRole = "owner" | "admin" | "member";
export type MemberStatus = "invited" | "active" | "suspended" | "removed";

interface CompanyMemberAttributes {
  id: number;
  companyId: number;
  userId?: number | null;
  email: string;
  role: CompanyRole;
  status: MemberStatus;
  expiresAt?: Date | null;
  removedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type CompanyMemberCreation = Optional<
  CompanyMemberAttributes,
  "id" | "userId" | "status" | "expiresAt" | "removedAt" | "createdAt" | "updatedAt"
>;

class CompanyMember
  extends Model<CompanyMemberAttributes, CompanyMemberCreation>
  implements CompanyMemberAttributes
{
  public id!: number;
  public companyId!: number;
  public userId?: number | null;
  public email!: string;
  public role!: CompanyRole;
  public status!: MemberStatus;
  public expiresAt?: Date | null;
  public removedAt?: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

CompanyMember.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM("owner", "admin", "member"),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("invited", "active", "suspended", "removed"),
      allowNull: false,
      defaultValue: "invited",
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    removedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "company_members",
    timestamps: true,
  }
);

export default CompanyMember;

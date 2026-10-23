import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type CompanyStatus = "active" | "suspended";

/** Security rules owners and admins set for everyone in the company. */
export interface CompanyPolicies {
  /** Members without two-factor sign-in can't open company items. */
  require2fa?: boolean;
  /** Passwords in company logins must be at least this long. */
  minPasswordLength?: number | null;
  /** Sign members out once a sign-in is this many days old. */
  maxSessionDays?: number | null;
  /** Members' vault locks after at most this many idle minutes. */
  maxIdleMinutes?: number | null;
}

interface CompanyAttributes {
  id: number;
  name: string;
  status: CompanyStatus;
  policies?: CompanyPolicies;
  createdAt?: Date;
  updatedAt?: Date;
}

type CompanyCreation = Optional<
  CompanyAttributes,
  "id" | "status" | "policies" | "createdAt" | "updatedAt"
>;

class Company extends Model<CompanyAttributes, CompanyCreation> implements CompanyAttributes {
  public id!: number;
  public name!: string;
  public status!: CompanyStatus;
  public policies!: CompanyPolicies;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Company.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("active", "suspended"),
      allowNull: false,
      defaultValue: "active",
    },
    policies: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
  },
  {
    sequelize,
    tableName: "companies",
    timestamps: true,
  }
);

export default Company;

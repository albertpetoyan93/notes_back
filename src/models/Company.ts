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
  /** When it was suspended for not paying (Team ended unpaid). */
  suspendedAt?: Date | null;
  /** Removal warnings sent while suspended (at 60 and 83 days). */
  removalWarnings?: number;
  /** Unpaid for 90 days: marked, but deleted only when removal is switched on. */
  markedForRemovalAt?: Date | null;
  /** Admin recovery (migration 040): the company's recovery public key and its version, while on. */
  recoveryPublicKey?: string | null;
  recoveryKeyVersion?: number | null;
  /** 50% off Team (migration 041), once 2keevo approved a request. */
  discount?: "nonprofit" | "school" | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type CompanyCreation = Optional<
  CompanyAttributes,
  "id" | "status" | "policies" | "suspendedAt" | "removalWarnings" | "markedForRemovalAt" | "recoveryPublicKey" | "recoveryKeyVersion" | "discount" | "createdAt" | "updatedAt"
>;

class Company extends Model<CompanyAttributes, CompanyCreation> implements CompanyAttributes {
  public id!: number;
  public name!: string;
  public status!: CompanyStatus;
  public policies!: CompanyPolicies;
  public suspendedAt?: Date | null;
  public removalWarnings!: number;
  public markedForRemovalAt?: Date | null;
  public recoveryPublicKey?: string | null;
  public recoveryKeyVersion?: number | null;
  public discount?: "nonprofit" | "school" | null;
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
    suspendedAt: { type: DataTypes.DATE, allowNull: true },
    removalWarnings: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    markedForRemovalAt: { type: DataTypes.DATE, allowNull: true },
    recoveryPublicKey: { type: DataTypes.STRING(64), allowNull: true },
    recoveryKeyVersion: { type: DataTypes.INTEGER, allowNull: true },
    discount: { type: DataTypes.STRING(16), allowNull: true },
  },
  {
    sequelize,
    tableName: "companies",
    timestamps: true,
  }
);

export default Company;

import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type SessionKind = "web" | "extension" | "admin";

interface UserSessionAttributes {
  id: number;
  userId: number;
  kind: SessionKind;
  tokenHash: string;
  previousTokenHash?: string | null;
  rotatedAt?: Date | null;
  userAgent?: string | null;
  ip?: string | null;
  /** Last X-Keevo-Extension-Version from an extension session. */
  extensionVersion?: string | null;
  lastUsedAt: Date;
  /** Last real input from the person (web sessions); drives auto-lock. */
  lastActiveAt?: Date | null;
  /** Set while the session is locked. */
  lockedAt?: Date | null;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

type UserSessionCreation = Optional<
  UserSessionAttributes,
  | "id"
  | "previousTokenHash"
  | "rotatedAt"
  | "userAgent"
  | "ip"
  | "extensionVersion"
  | "lastUsedAt"
  | "lastActiveAt"
  | "lockedAt"
  | "createdAt"
  | "updatedAt"
>;

class UserSession
  extends Model<UserSessionAttributes, UserSessionCreation>
  implements UserSessionAttributes
{
  public id!: number;
  public userId!: number;
  public kind!: SessionKind;
  public tokenHash!: string;
  public previousTokenHash?: string | null;
  public rotatedAt?: Date | null;
  public userAgent?: string | null;
  public ip?: string | null;
  public extensionVersion?: string | null;
  public lastUsedAt!: Date;
  public lastActiveAt?: Date | null;
  public lockedAt?: Date | null;
  public expiresAt!: Date;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

UserSession.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    kind: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "web",
    },
    tokenHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    previousTokenHash: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    rotatedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    userAgent: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    ip: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    extensionVersion: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    lastActiveAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    lockedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: "user_sessions",
    timestamps: true,
  }
);

export default UserSession;

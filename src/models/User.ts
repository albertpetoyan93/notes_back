import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import bcrypt from "bcrypt";

interface UserAttributes {
  id: number;
  username: string;
  email: string;
  password: string;
  fullName?: string;
  refreshTokenId?: string | null;
  extensionRefreshTokenId?: string | null;
  passwordResetTokenHash?: string | null;
  passwordResetExpires?: Date | null;
  twoFactorEnabled?: boolean;
  twoFactorSecret?: string | null;
  twoFactorRecoveryCodes?: string[] | null;
  twoFactorLastStep?: number | null;
  /** Lock the vault after this many idle minutes; 0 = never. */
  autoLockMinutes?: number;
  // End-to-end encryption (E2E_DESIGN.md). All key values are locked (wrapped).
  e2eEnabled?: boolean;
  e2eSince?: Date | null;
  /** A company admin set a temporary master password: the person chooses their own at next sign-in. */
  mustChangeMasterPassword?: boolean;
  kdfSalt?: string | null;
  kdfParams?: { algorithm: "argon2id"; memory: number; iterations: number; parallelism: number } | null;
  protectedUserKey?: string | null;
  publicKey?: string | null;
  protectedPrivateKey?: string | null;
  recoveryProtectedUserKey?: string | null;
  recoveryAuthHash?: string | null;
  /** Staff suspended the account: sign-in and refresh are refused. */
  suspendedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface UserCreationAttributes
  extends Optional<
    UserAttributes,
    | "id"
    | "fullName"
    | "refreshTokenId"
    | "extensionRefreshTokenId"
    | "passwordResetTokenHash"
    | "passwordResetExpires"
    | "twoFactorEnabled"
    | "twoFactorSecret"
    | "twoFactorRecoveryCodes"
    | "twoFactorLastStep"
    | "autoLockMinutes"
    | "e2eEnabled"
    | "e2eSince"
    | "mustChangeMasterPassword"
    | "kdfSalt"
    | "kdfParams"
    | "protectedUserKey"
    | "publicKey"
    | "protectedPrivateKey"
    | "recoveryProtectedUserKey"
    | "recoveryAuthHash"
    | "suspendedAt"
    | "createdAt"
    | "updatedAt"
  > {}

class User
  extends Model<UserAttributes, UserCreationAttributes>
  implements UserAttributes
{
  public id!: number;
  public username!: string;
  public email!: string;
  public password!: string;
  public fullName?: string;
  public refreshTokenId?: string | null;
  public extensionRefreshTokenId?: string | null;
  public passwordResetTokenHash?: string | null;
  public passwordResetExpires?: Date | null;
  public twoFactorEnabled!: boolean;
  public twoFactorSecret?: string | null;
  public twoFactorRecoveryCodes?: string[] | null;
  public twoFactorLastStep?: number | null;
  public autoLockMinutes!: number;
  public e2eEnabled!: boolean;
  public e2eSince?: Date | null;
  public mustChangeMasterPassword!: boolean;
  public kdfSalt?: string | null;
  public kdfParams?: UserAttributes["kdfParams"];
  public protectedUserKey?: string | null;
  public publicKey?: string | null;
  public protectedPrivateKey?: string | null;
  public recoveryProtectedUserKey?: string | null;
  public recoveryAuthHash?: string | null;
  public suspendedAt?: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;

  // Method to compare password
  public async comparePassword(password: string): Promise<boolean> {
    return bcrypt.compare(password, this.password);
  }
}

User.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    username: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true,
      },
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    fullName: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    refreshTokenId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    extensionRefreshTokenId: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    passwordResetTokenHash: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    passwordResetExpires: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    twoFactorEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    autoLockMinutes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 15,
    },
    e2eEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    e2eSince: { type: DataTypes.DATE, allowNull: true },
    mustChangeMasterPassword: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    kdfSalt: { type: DataTypes.STRING(64), allowNull: true },
    kdfParams: { type: DataTypes.JSONB, allowNull: true },
    protectedUserKey: { type: DataTypes.TEXT, allowNull: true },
    publicKey: { type: DataTypes.STRING(64), allowNull: true },
    protectedPrivateKey: { type: DataTypes.TEXT, allowNull: true },
    recoveryProtectedUserKey: { type: DataTypes.TEXT, allowNull: true },
    recoveryAuthHash: { type: DataTypes.STRING(100), allowNull: true },
    suspendedAt: { type: DataTypes.DATE, allowNull: true },
    twoFactorSecret: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    twoFactorRecoveryCodes: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    twoFactorLastStep: {
      type: DataTypes.BIGINT,
      allowNull: true,
      // Postgres returns BIGINT as a string.
      get() {
        const value = this.getDataValue("twoFactorLastStep");
        return value === null || value === undefined ? null : Number(value);
      },
    },
  },
  {
    sequelize,
    tableName: "users",
    timestamps: true,
    hooks: {
      beforeCreate: async (user: User) => {
        if (user.password) {
          const salt = await bcrypt.genSalt(10);
          user.password = await bcrypt.hash(user.password, salt);
        }
      },
      beforeUpdate: async (user: User) => {
        if (user.changed("password")) {
          const salt = await bcrypt.genSalt(10);
          user.password = await bcrypt.hash(user.password, salt);
        }
      },
    },
  }
);

export default User;

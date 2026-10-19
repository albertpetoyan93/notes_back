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

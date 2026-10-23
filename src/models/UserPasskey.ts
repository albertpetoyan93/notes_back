import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface UserPasskeyAttributes {
  id: number;
  userId: number;
  /** base64url, as the browser reports it. */
  credentialId: string;
  /** base64url of the COSE public key. */
  publicKey: string;
  counter: number;
  transports: string[];
  /** "singleDevice" or "multiDevice" (synced, e.g. iCloud Keychain or Google Password Manager). */
  deviceType?: string | null;
  backedUp: boolean;
  name: string;
  lastUsedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type UserPasskeyCreation = Optional<
  UserPasskeyAttributes,
  "id" | "counter" | "transports" | "deviceType" | "backedUp" | "lastUsedAt" | "createdAt" | "updatedAt"
>;

class UserPasskey
  extends Model<UserPasskeyAttributes, UserPasskeyCreation>
  implements UserPasskeyAttributes
{
  public id!: number;
  public userId!: number;
  public credentialId!: string;
  public publicKey!: string;
  public counter!: number;
  public transports!: string[];
  public deviceType?: string | null;
  public backedUp!: boolean;
  public name!: string;
  public lastUsedAt?: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

UserPasskey.init(
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
    credentialId: {
      type: DataTypes.STRING(1024),
      allowNull: false,
      unique: true,
    },
    publicKey: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    counter: {
      // BIGINT comes back from pg as a string; keep it a number for the library.
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      get() {
        return Number(this.getDataValue("counter") || 0);
      },
    },
    transports: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    deviceType: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    backedUp: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "user_passkeys",
    timestamps: true,
  }
);

export default UserPasskey;

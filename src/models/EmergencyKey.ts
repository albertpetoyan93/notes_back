import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/**
 * An owner's emergency key (migration 058), wrapped by their browser with their
 * user key. Emergency contacts get this key, never the user key: it opens only
 * the owner's personal items. `rotate`: access that had been granted ended, so
 * the owner's browser makes a new one.
 */
interface EmergencyKeyAttributes {
  userId: number;
  keyVersion: number;
  wrappedKey: string;
  rotate: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

class EmergencyKey
  extends Model<EmergencyKeyAttributes, Optional<EmergencyKeyAttributes, "rotate" | "createdAt" | "updatedAt">>
  implements EmergencyKeyAttributes
{
  public userId!: number;
  public keyVersion!: number;
  public wrappedKey!: string;
  public rotate!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

EmergencyKey.init(
  {
    userId: { type: DataTypes.INTEGER, primaryKey: true },
    keyVersion: { type: DataTypes.INTEGER, allowNull: false },
    wrappedKey: { type: DataTypes.TEXT, allowNull: false },
    rotate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { sequelize, tableName: "emergency_keys", timestamps: true }
);

export default EmergencyKey;

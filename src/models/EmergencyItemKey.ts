import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/** A personal item's key wrapped with its owner's emergency key of `keyVersion` (migration 058). */
interface EmergencyItemKeyAttributes {
  id: number;
  grantorId: number;
  noteId: number;
  keyVersion: number;
  wrappedKey: string;
  createdAt?: Date;
  updatedAt?: Date;
}

class EmergencyItemKey
  extends Model<EmergencyItemKeyAttributes, Optional<EmergencyItemKeyAttributes, "id" | "createdAt" | "updatedAt">>
  implements EmergencyItemKeyAttributes
{
  public id!: number;
  public grantorId!: number;
  public noteId!: number;
  public keyVersion!: number;
  public wrappedKey!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

EmergencyItemKey.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    grantorId: { type: DataTypes.INTEGER, allowNull: false },
    noteId: { type: DataTypes.INTEGER, allowNull: false },
    keyVersion: { type: DataTypes.INTEGER, allowNull: false },
    wrappedKey: { type: DataTypes.TEXT, allowNull: false },
  },
  { sequelize, tableName: "emergency_item_keys", timestamps: true }
);

export default EmergencyItemKey;

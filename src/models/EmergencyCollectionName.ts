import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/** A personal collection's name encrypted with its owner's emergency key of `keyVersion` (migration 058). */
interface EmergencyCollectionNameAttributes {
  id: number;
  grantorId: number;
  collectionId: number;
  keyVersion: number;
  encName: string;
  createdAt?: Date;
  updatedAt?: Date;
}

class EmergencyCollectionName
  extends Model<
    EmergencyCollectionNameAttributes,
    Optional<EmergencyCollectionNameAttributes, "id" | "createdAt" | "updatedAt">
  >
  implements EmergencyCollectionNameAttributes
{
  public id!: number;
  public grantorId!: number;
  public collectionId!: number;
  public keyVersion!: number;
  public encName!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

EmergencyCollectionName.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    grantorId: { type: DataTypes.INTEGER, allowNull: false },
    collectionId: { type: DataTypes.INTEGER, allowNull: false },
    keyVersion: { type: DataTypes.INTEGER, allowNull: false },
    encName: { type: DataTypes.TEXT, allowNull: false },
  },
  { sequelize, tableName: "emergency_collection_names", timestamps: true }
);

export default EmergencyCollectionName;

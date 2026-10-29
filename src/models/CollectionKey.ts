import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/**
 * A collection's key, sealed to one person's public key (E2E_DESIGN.md,
 * stage 10.4). Only the current version is kept: after someone loses access,
 * an owner's or admin's browser makes a new key and seals it again.
 */
interface CollectionKeyAttributes {
  id: number;
  collectionId: number;
  userId: number;
  keyVersion: number;
  wrappedKey: string;
  /** Whose browser sealed it (for "Ana now has access"). */
  grantedBy?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type CollectionKeyCreation = Optional<CollectionKeyAttributes, "id" | "grantedBy" | "createdAt" | "updatedAt">;

class CollectionKey
  extends Model<CollectionKeyAttributes, CollectionKeyCreation>
  implements CollectionKeyAttributes
{
  public id!: number;
  public collectionId!: number;
  public userId!: number;
  public keyVersion!: number;
  public wrappedKey!: string;
  public grantedBy?: number | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

CollectionKey.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    collectionId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    keyVersion: { type: DataTypes.INTEGER, allowNull: false },
    wrappedKey: { type: DataTypes.TEXT, allowNull: false },
    grantedBy: { type: DataTypes.INTEGER, allowNull: true },
  },
  { sequelize, tableName: "collection_keys", timestamps: true }
);

export default CollectionKey;

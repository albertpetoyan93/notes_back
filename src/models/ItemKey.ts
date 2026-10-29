import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/**
 * An end-to-end item's key for one more way in (E2E_DESIGN.md, stage 10.4).
 * "user": sealed to that person's public key (a direct share).
 * "collection": wrapped with that collection's key of `keyVersion`.
 * The owner's own copy stays on the item row ("notes"."itemKey").
 */
interface ItemKeyAttributes {
  id: number;
  noteId: number;
  containerType: "user" | "collection";
  containerId: number;
  keyVersion?: number | null;
  wrappedKey: string;
  createdAt?: Date;
  updatedAt?: Date;
}

type ItemKeyCreation = Optional<ItemKeyAttributes, "id" | "keyVersion" | "createdAt" | "updatedAt">;

class ItemKey extends Model<ItemKeyAttributes, ItemKeyCreation> implements ItemKeyAttributes {
  public id!: number;
  public noteId!: number;
  public containerType!: "user" | "collection";
  public containerId!: number;
  public keyVersion?: number | null;
  public wrappedKey!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

ItemKey.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    noteId: { type: DataTypes.INTEGER, allowNull: false },
    containerType: { type: DataTypes.STRING(16), allowNull: false },
    containerId: { type: DataTypes.INTEGER, allowNull: false },
    keyVersion: { type: DataTypes.INTEGER, allowNull: true },
    wrappedKey: { type: DataTypes.TEXT, allowNull: false },
  },
  { sequelize, tableName: "item_keys", timestamps: true }
);

export default ItemKey;

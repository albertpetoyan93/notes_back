import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import { SharePermission } from "./NoteShare";

interface CollectionShareAttributes {
  id: number;
  collectionId: number;
  sharedByUserId: number;
  sharedWithUserId: number;
  permission: SharePermission;
  expiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type CollectionShareCreation = Optional<
  CollectionShareAttributes,
  "id" | "permission" | "expiresAt" | "createdAt" | "updatedAt"
>;

class CollectionShare
  extends Model<CollectionShareAttributes, CollectionShareCreation>
  implements CollectionShareAttributes
{
  public id!: number;
  public collectionId!: number;
  public sharedByUserId!: number;
  public sharedWithUserId!: number;
  public permission!: SharePermission;
  public expiresAt?: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

CollectionShare.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    collectionId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    sharedByUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    sharedWithUserId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    permission: {
      type: DataTypes.ENUM("view", "edit"),
      allowNull: false,
      defaultValue: "view",
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "collection_shares",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["collectionId", "sharedWithUserId"],
        name: "collection_shares_collection_user_unique",
      },
    ],
  }
);

export default CollectionShare;

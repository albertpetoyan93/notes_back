import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import { SharePermission } from "./NoteShare";

export type GrantSource = "direct" | "admin_legacy" | "self" | "recovery";

interface CollectionShareAttributes {
  id: number;
  collectionId: number;
  sharedByUserId: number;
  sharedWithUserId: number;
  permission: SharePermission;
  expiresAt?: Date | null;
  /** A vault manager (ADR-002): shares the vault and hands its key to newcomers. */
  manages?: boolean;
  /** How the grant came about: shared, kept from admin-by-role, self-given by an admin, or by recovery. */
  source?: GrantSource;
  /** What the share was before migration 055 raised it for an admin (put back if they're made member). */
  priorPermission?: SharePermission | null;
  priorManages?: boolean | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type CollectionShareCreation = Optional<
  CollectionShareAttributes,
  "id" | "permission" | "expiresAt" | "manages" | "source" | "priorPermission" | "priorManages" | "createdAt" | "updatedAt"
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
  public manages!: boolean;
  public source!: GrantSource;
  public priorPermission?: SharePermission | null;
  public priorManages?: boolean | null;
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
    manages: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    source: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "direct" },
    priorPermission: { type: DataTypes.STRING(10), allowNull: true },
    priorManages: { type: DataTypes.BOOLEAN, allowNull: true },
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

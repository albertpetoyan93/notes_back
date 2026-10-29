import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface CollectionAttributes {
  id: number;
  userId: number;
  name: string;
  companyId?: number | null;
  companyShare?: "view" | "edit" | null;
  /** End-to-end: the current key version, or null while readable. */
  e2eKeyVersion?: number | null;
  /** The organizer's shared family collection (one per organizer). */
  family?: boolean;
  /** The name encrypted in the browser, and with what ("user" or "v<N>"); `name` is then a placeholder. */
  encName?: string | null;
  nameKey?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type CollectionCreation = Optional<
  CollectionAttributes,
  "id" | "companyId" | "companyShare" | "e2eKeyVersion" | "family" | "encName" | "nameKey" | "createdAt" | "updatedAt"
>;

class Collection
  extends Model<CollectionAttributes, CollectionCreation>
  implements CollectionAttributes
{
  public id!: number;
  public userId!: number;
  public name!: string;
  public companyId?: number | null;
  public companyShare?: "view" | "edit" | null;
  public e2eKeyVersion?: number | null;
  public family!: boolean;
  public encName?: string | null;
  public nameKey?: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Collection.init(
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
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    companyShare: {
      type: DataTypes.STRING(4),
      allowNull: true,
    },
    e2eKeyVersion: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    family: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    encName: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    nameKey: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "collections",
    timestamps: true,
  }
);

export default Collection;

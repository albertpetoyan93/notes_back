import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface CollectionAttributes {
  id: number;
  userId: number;
  name: string;
  companyId?: number | null;
  companyShare?: "view" | "edit" | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type CollectionCreation = Optional<
  CollectionAttributes,
  "id" | "companyId" | "companyShare" | "createdAt" | "updatedAt"
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
  },
  {
    sequelize,
    tableName: "collections",
    timestamps: true,
  }
);

export default Collection;

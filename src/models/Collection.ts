import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface CollectionAttributes {
  id: number;
  userId: number;
  name: string;
  createdAt?: Date;
  updatedAt?: Date;
}

type CollectionCreation = Optional<
  CollectionAttributes,
  "id" | "createdAt" | "updatedAt"
>;

class Collection
  extends Model<CollectionAttributes, CollectionCreation>
  implements CollectionAttributes
{
  public id!: number;
  public userId!: number;
  public name!: string;
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
  },
  {
    sequelize,
    tableName: "collections",
    timestamps: true,
  }
);

export default Collection;

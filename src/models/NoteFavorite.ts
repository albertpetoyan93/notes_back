import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface NoteFavoriteAttributes {
  id: number;
  noteId: number;
  userId: number;
  createdAt?: Date;
  updatedAt?: Date;
}

type NoteFavoriteCreation = Optional<
  NoteFavoriteAttributes,
  "id" | "createdAt" | "updatedAt"
>;

class NoteFavorite
  extends Model<NoteFavoriteAttributes, NoteFavoriteCreation>
  implements NoteFavoriteAttributes
{
  public id!: number;
  public noteId!: number;
  public userId!: number;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

NoteFavorite.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    noteId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: "note_favorites",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["noteId", "userId"],
        name: "note_favorites_note_user_unique",
      },
    ],
  }
);

export default NoteFavorite;

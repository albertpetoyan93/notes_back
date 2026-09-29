import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface NotificationAttributes {
  id: number;
  userId: number;
  noteId?: number | null;
  message: string;
  readAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type NotificationCreation = Optional<
  NotificationAttributes,
  "id" | "noteId" | "readAt" | "createdAt" | "updatedAt"
>;

class Notification
  extends Model<NotificationAttributes, NotificationCreation>
  implements NotificationAttributes
{
  public id!: number;
  public userId!: number;
  public noteId?: number | null;
  public message!: string;
  public readAt?: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Notification.init(
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
    noteId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    message: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "notifications",
    timestamps: true,
  }
);

export default Notification;

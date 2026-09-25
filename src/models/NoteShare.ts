import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type SharePermission = "view" | "edit";

interface NoteShareAttributes {
  id: number;
  noteId: number;
  sharedByUserId: number;
  sharedWithUserId: number;
  permission: SharePermission;
  createdAt?: Date;
  updatedAt?: Date;
}

interface NoteShareCreationAttributes
  extends Optional<
    NoteShareAttributes,
    "id" | "permission" | "createdAt" | "updatedAt"
  > {}

class NoteShare
  extends Model<NoteShareAttributes, NoteShareCreationAttributes>
  implements NoteShareAttributes
{
  public id!: number;
  public noteId!: number;
  public sharedByUserId!: number;
  public sharedWithUserId!: number;
  public permission!: SharePermission;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

NoteShare.init(
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
  },
  {
    sequelize,
    tableName: "note_shares",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["noteId", "sharedWithUserId"],
        name: "note_shares_note_user_unique",
      },
    ],
  }
);

export default NoteShare;

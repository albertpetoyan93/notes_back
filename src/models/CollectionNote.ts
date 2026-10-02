import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface CollectionNoteAttributes {
  id: number;
  collectionId: number;
  noteId: number;
  createdAt?: Date;
  updatedAt?: Date;
}

type CollectionNoteCreation = Optional<
  CollectionNoteAttributes,
  "id" | "createdAt" | "updatedAt"
>;

class CollectionNote
  extends Model<CollectionNoteAttributes, CollectionNoteCreation>
  implements CollectionNoteAttributes
{
  public id!: number;
  public collectionId!: number;
  public noteId!: number;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

CollectionNote.init(
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
    noteId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: "collection_notes",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["collectionId", "noteId"],
        name: "collection_notes_collection_note_unique",
      },
    ],
  }
);

export default CollectionNote;

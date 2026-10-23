import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/** One saved state of an item. `content` is stored encrypted (v2 format). */
interface NoteVersionAttributes {
  id: number;
  noteId: number;
  title: string;
  category: string;
  tags: string[];
  /** Encrypted with util/encryption; VersionService decrypts it. */
  content: string;
  /** What changed in this save: field names, "Title", "Notes"… never values. */
  changes: string[];
  changedBy: number | null;
  createdAt: Date;
}

type NoteVersionCreation = Optional<
  NoteVersionAttributes,
  "id" | "tags" | "changes" | "changedBy" | "createdAt"
>;

class NoteVersion
  extends Model<NoteVersionAttributes, NoteVersionCreation>
  implements NoteVersionAttributes
{
  public id!: number;
  public noteId!: number;
  public title!: string;
  public category!: string;
  public tags!: string[];
  public content!: string;
  public changes!: string[];
  public changedBy!: number | null;
  public createdAt!: Date;
}

NoteVersion.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    noteId: { type: DataTypes.INTEGER, allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: false },
    category: { type: DataTypes.STRING(50), allowNull: false },
    tags: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    content: { type: DataTypes.TEXT, allowNull: false },
    changes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    changedBy: { type: DataTypes.INTEGER, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: "note_versions",
    timestamps: false,
  }
);

export default NoteVersion;

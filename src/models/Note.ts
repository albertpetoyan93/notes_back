import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import { encryptContent, decryptContent } from "../util/encryption";

interface NoteAttributes {
  id: number;
  title: string;
  content: Record<string, any>; // JSONB object for flexible key-value storage
  comment?: string;
  category: "note" | "password" | "login" | "command" | "ssh" | "db" | "other";
  project?: string;
  tags?: string[];
  isFavorite: boolean;
  isEncrypted: boolean;
  userId: number;
  createdAt?: Date;
  updatedAt?: Date;
}

interface NoteCreationAttributes
  extends Optional<
    NoteAttributes,
    | "id"
    | "comment"
    | "project"
    | "tags"
    | "isFavorite"
    | "isEncrypted"
    | "createdAt"
    | "updatedAt"
  > {}

class Note
  extends Model<NoteAttributes, NoteCreationAttributes>
  implements NoteAttributes
{
  public id!: number;
  public title!: string;
  public content!: Record<string, any>; // JSONB object for flexible key-value storage
  public comment?: string;
  public category!:
    | "note"
    | "password"
    | "login"
    | "command"
    | "ssh"
    | "db"
    | "other";
  public project?: string;
  public tags?: string[];
  public isFavorite!: boolean;
  public isEncrypted!: boolean;
  public userId!: number;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Note.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    content: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    comment: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: "",
    },
    category: {
      type: DataTypes.ENUM(
        "note",
        "password",
        "login",
        "command",
        "ssh",
        "db",
        "other"
      ),
      allowNull: false,
      defaultValue: "note",
    },
    project: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: null,
    },
    tags: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: [],
    },
    isFavorite: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    isEncrypted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: "notes",
    timestamps: true,
    hooks: {
      // Auto-enable encryption for password and login categories
      beforeValidate: async (note: Note) => {
        if (note.category === "password" || note.category === "login") {
          note.isEncrypted = true;
        }
      },
      // Encrypt before saving to database
      beforeCreate: async (note: Note) => {
        if (note.isEncrypted && note.content) {
          const encrypted = encryptContent(note.content);
          note.setDataValue("content", encrypted);
        }
      },
      beforeUpdate: async (note: Note) => {
        if (note.isEncrypted && note.changed("content")) {
          const encrypted = encryptContent(note.content);
          note.setDataValue("content", encrypted);
        }
      },
      // Decrypt after retrieving from database
      afterFind: (result: Note | Note[] | null) => {
        if (!result) return;

        const notes = Array.isArray(result) ? result : [result];

        notes.forEach((note) => {
          if (note && note.isEncrypted && note.getDataValue("content")) {
            try {
              const decrypted = decryptContent(note.getDataValue("content"));
              note.setDataValue("content", decrypted);
            } catch (error) {
              console.error("Error decrypting content:", error);
            }
          }
        });
      },
    },
  }
);

export default Note;

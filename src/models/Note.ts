import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import {
  decryptContent,
  encryptContent,
  isDecryptionFailure,
} from "../util/encryption";

interface NoteAttributes {
  id: number;
  title: string;
  content: Record<string, any>; // JSONB object for flexible key-value storage
  comment?: string;
  category:
    | "note"
    | "password"
    | "login"
    | "command"
    | "ssh"
    | "db"
    | "address"
    | "card"
    | "other";
  project?: string | null;
  tags?: string[];
  isEncrypted: boolean;
  /** Encrypted in the browser (E2E_DESIGN.md, stage 10.3): see encData. */
  e2e?: boolean;
  e2eId?: string | null;
  itemKey?: string | null;
  encData?: string | null;
  userId: number;
  collectionId?: number | null;
  deletedAt?: Date | null;
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
    | "isEncrypted"
    | "e2e"
    | "e2eId"
    | "itemKey"
    | "encData"
    | "collectionId"
    | "deletedAt"
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
    | "address"
    | "card"
    | "other";
  public project?: string | null;
  public tags?: string[];
  public isEncrypted!: boolean;
  public e2e!: boolean;
  public e2eId?: string | null;
  public itemKey?: string | null;
  public encData?: string | null;
  public userId!: number;
  public collectionId?: number | null;
  public deletedAt?: Date | null;
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
        "address",
        "card",
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
    isEncrypted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    e2e: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    e2eId: { type: DataTypes.STRING(32), allowNull: true },
    itemKey: { type: DataTypes.TEXT, allowNull: true },
    encData: { type: DataTypes.TEXT, allowNull: true },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    collectionId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    deletedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: "notes",
    timestamps: true,
    paranoid: true,
    hooks: {
      // Every item is encrypted at rest; SSH keys and DB logins are as secret as passwords.
      beforeValidate: async (note: Note) => {
        note.isEncrypted = true;
      },
      // Encrypt before saving to database
      beforeCreate: async (note: Note) => {
        if (isDecryptionFailure(note.content)) {
          throw new Error("Content could not be decrypted");
        }
        if (note.content) {
          note.setDataValue("content", encryptContent(note.content));
        }
      },
      beforeUpdate: async (note: Note) => {
        if (!note.changed("content")) return;
        // afterFind put a placeholder here because decryption failed. Keep the
        // stored ciphertext so saving other fields cannot wipe the item.
        if (isDecryptionFailure(note.content)) {
          note.setDataValue("content", note.previous("content") as any);
          return;
        }
        note.setDataValue("content", encryptContent(note.content));
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

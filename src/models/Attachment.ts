import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type AttachmentStatus = "uploading" | "ready";

/** An encrypted file on an item (migration 044). The bytes live in object storage. */
interface AttachmentAttributes {
  /** Random, URL-safe; also the storage key and bound into the file's encryption. */
  id: string;
  noteId?: number | null;
  uploadedBy?: number | null;
  /** Whose storage it counts against: a person, or a company for company items. */
  ownerUserId?: number | null;
  companyId?: number | null;
  /** Stored (encrypted) size in bytes. */
  size: number;
  status: AttachmentStatus;
  /** Name and type, encrypted with the file key. */
  encMeta?: string | null;
  /** The file key, wrapped with the item key. */
  wrappedKey?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type AttachmentCreation = Optional<
  AttachmentAttributes,
  "noteId" | "uploadedBy" | "ownerUserId" | "companyId" | "status" | "encMeta" | "wrappedKey" | "createdAt" | "updatedAt"
>;

class Attachment extends Model<AttachmentAttributes, AttachmentCreation> implements AttachmentAttributes {
  public id!: string;
  public noteId?: number | null;
  public uploadedBy?: number | null;
  public ownerUserId?: number | null;
  public companyId?: number | null;
  public size!: number;
  public status!: AttachmentStatus;
  public encMeta?: string | null;
  public wrappedKey?: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Attachment.init(
  {
    id: { type: DataTypes.STRING(32), primaryKey: true },
    noteId: { type: DataTypes.INTEGER, allowNull: true },
    uploadedBy: { type: DataTypes.INTEGER, allowNull: true },
    ownerUserId: { type: DataTypes.INTEGER, allowNull: true },
    companyId: { type: DataTypes.INTEGER, allowNull: true },
    // BIGINT comes back as a string from pg; read it as a number.
    size: {
      type: DataTypes.BIGINT,
      allowNull: false,
      get() {
        return Number(this.getDataValue("size"));
      },
    },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "uploading" },
    encMeta: { type: DataTypes.TEXT, allowNull: true },
    wrappedKey: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, tableName: "attachments", timestamps: true }
);

export default Attachment;

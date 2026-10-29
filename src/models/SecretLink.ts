import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/** A one-time link. The server can't read the secret: the key is in the link. */
interface SecretLinkAttributes {
  id: string;
  /** base64url AES-GCM ciphertext; null once used up, revoked or expired. */
  ciphertext: string | null;
  iv: string;
  /** Set when a passphrase is needed. */
  salt: string | null;
  /** Links made before proofHash: "iv.ciphertext" of a known text, checked by the page. */
  check: string | null;
  /** SHA-256 (hex) of the passphrase proof the browser sends to open the link. */
  proofHash: string | null;
  /** Wrong passphrases so far; MAX_ATTEMPTS destroy the link. */
  failedAttempts: number;
  /** The creator's own name for the link, encrypted with the server key. */
  label: string | null;
  maxViews: number;
  viewCount: number;
  expiresAt: Date;
  revokedAt: Date | null;
  openedAt: Date | null;
  createdBy: number;
  noteId: number | null;
  createdAt: Date;
}

type SecretLinkCreation = Optional<
  SecretLinkAttributes,
  "salt" | "check" | "proofHash" | "failedAttempts" | "label" | "maxViews" | "viewCount" | "revokedAt" | "openedAt" | "noteId" | "createdAt"
>;

class SecretLink
  extends Model<SecretLinkAttributes, SecretLinkCreation>
  implements SecretLinkAttributes
{
  public id!: string;
  public ciphertext!: string | null;
  public iv!: string;
  public salt!: string | null;
  public check!: string | null;
  public proofHash!: string | null;
  public failedAttempts!: number;
  public label!: string | null;
  public maxViews!: number;
  public viewCount!: number;
  public expiresAt!: Date;
  public revokedAt!: Date | null;
  public openedAt!: Date | null;
  public createdBy!: number;
  public noteId!: number | null;
  public createdAt!: Date;
}

SecretLink.init(
  {
    id: { type: DataTypes.STRING(32), primaryKey: true },
    ciphertext: { type: DataTypes.TEXT, allowNull: true },
    iv: { type: DataTypes.STRING(32), allowNull: false },
    salt: { type: DataTypes.STRING(64), allowNull: true },
    check: { type: DataTypes.TEXT, allowNull: true },
    proofHash: { type: DataTypes.STRING(64), allowNull: true },
    failedAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    label: { type: DataTypes.TEXT, allowNull: true },
    maxViews: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    viewCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    openedAt: { type: DataTypes.DATE, allowNull: true },
    createdBy: { type: DataTypes.INTEGER, allowNull: false },
    noteId: { type: DataTypes.INTEGER, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "secret_links", timestamps: false }
);

export default SecretLink;

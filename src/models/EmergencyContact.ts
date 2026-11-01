import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/**
 * invited   → the owner asked; the contact hasn't accepted yet (may not have an account)
 * accepted  → the contact accepted; the owner's browser still has to seal the key to them
 * confirmed → ready: the contact can ask for access
 * requested → the contact asked; access is granted when the wait ends, unless refused
 * granted   → the contact can read the owner's personal vault
 */
export type EmergencyStatus = "invited" | "accepted" | "confirmed" | "requested" | "granted";

/** Emergency access (migration 042). */
interface EmergencyContactAttributes {
  id: number;
  grantorId: number;
  contactId?: number | null;
  email: string;
  waitDays: number;
  status: EmergencyStatus;
  /** The owner's user key, sealed by their browser to the contact's public key. */
  sealedUserKey?: string | null;
  requestedAt?: Date | null;
  grantedAt?: Date | null;
  /** Reminders sent to the owner for the current request (halfway, last day). */
  remindersSent: number;
  createdAt?: Date;
  updatedAt?: Date;
}

type EmergencyContactCreation = Optional<
  EmergencyContactAttributes,
  "id" | "contactId" | "waitDays" | "status" | "sealedUserKey" | "requestedAt" | "grantedAt" | "remindersSent" | "createdAt" | "updatedAt"
>;

class EmergencyContact
  extends Model<EmergencyContactAttributes, EmergencyContactCreation>
  implements EmergencyContactAttributes
{
  public id!: number;
  public grantorId!: number;
  public contactId?: number | null;
  public email!: string;
  public waitDays!: number;
  public status!: EmergencyStatus;
  public sealedUserKey?: string | null;
  public requestedAt?: Date | null;
  public grantedAt?: Date | null;
  public remindersSent!: number;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

EmergencyContact.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    grantorId: { type: DataTypes.INTEGER, allowNull: false },
    contactId: { type: DataTypes.INTEGER, allowNull: true },
    email: { type: DataTypes.STRING(255), allowNull: false },
    waitDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 7 },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "invited" },
    sealedUserKey: { type: DataTypes.TEXT, allowNull: true },
    requestedAt: { type: DataTypes.DATE, allowNull: true },
    grantedAt: { type: DataTypes.DATE, allowNull: true },
    remindersSent: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { sequelize, tableName: "emergency_contacts", timestamps: true }
);

export default EmergencyContact;

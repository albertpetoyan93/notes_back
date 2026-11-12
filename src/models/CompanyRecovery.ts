import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/**
 * Vault recovery (migrations 040, 051; ADR-001 option A).
 * - `CompanyRecoveryKey`: the company's recovery private key, sealed to one custodian.
 * - `RecoveryCustodian`: who the company named to hold it (owners and admins).
 * - `VaultRecoveryKey`: one company collection's key, sealed to the recovery public key.
 * - `RecoveryRequest`: a request to give someone a vault's key, approved by a second
 *   person and run after a waiting period.
 * Nothing here opens a member's personal items: user keys are not sealed to the company.
 */
interface CompanyRecoveryKeyAttributes {
  id: number;
  companyId: number;
  userId: number;
  keyVersion: number;
  wrappedKey: string;
}

export class CompanyRecoveryKey
  extends Model<CompanyRecoveryKeyAttributes, Optional<CompanyRecoveryKeyAttributes, "id">>
  implements CompanyRecoveryKeyAttributes
{
  public id!: number;
  public companyId!: number;
  public userId!: number;
  public keyVersion!: number;
  public wrappedKey!: string;
}

CompanyRecoveryKey.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    companyId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    keyVersion: { type: DataTypes.INTEGER, allowNull: false },
    wrappedKey: { type: DataTypes.TEXT, allowNull: false },
  },
  { sequelize, tableName: "company_recovery_keys", timestamps: true }
);

interface RecoveryCustodianAttributes {
  id: number;
  companyId: number;
  userId: number;
  addedBy?: number | null;
}

export class RecoveryCustodian
  extends Model<RecoveryCustodianAttributes, Optional<RecoveryCustodianAttributes, "id" | "addedBy">>
  implements RecoveryCustodianAttributes
{
  public id!: number;
  public companyId!: number;
  public userId!: number;
  public addedBy?: number | null;
}

RecoveryCustodian.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    companyId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    addedBy: { type: DataTypes.INTEGER, allowNull: true },
  },
  { sequelize, tableName: "company_recovery_custodians", timestamps: true }
);

interface VaultRecoveryKeyAttributes {
  id: number;
  companyId: number;
  collectionId: number;
  /** The collection key's version this copy is of. */
  keyVersion: number;
  /** The recovery key version it is sealed to (may be earlier than the company's current one). */
  recoveryKeyVersion: number;
  /** The recovery public key of that version (migration 052). */
  recoveryPublicKey?: string | null;
  wrappedKey: string;
}

export class VaultRecoveryKey
  extends Model<VaultRecoveryKeyAttributes, Optional<VaultRecoveryKeyAttributes, "id" | "recoveryPublicKey">>
  implements VaultRecoveryKeyAttributes
{
  public id!: number;
  public companyId!: number;
  public collectionId!: number;
  public keyVersion!: number;
  public recoveryKeyVersion!: number;
  public recoveryPublicKey?: string | null;
  public wrappedKey!: string;
}

VaultRecoveryKey.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    companyId: { type: DataTypes.INTEGER, allowNull: false },
    collectionId: { type: DataTypes.INTEGER, allowNull: false },
    keyVersion: { type: DataTypes.INTEGER, allowNull: false },
    recoveryKeyVersion: { type: DataTypes.INTEGER, allowNull: false },
    recoveryPublicKey: { type: DataTypes.STRING(64), allowNull: true },
    wrappedKey: { type: DataTypes.TEXT, allowNull: false },
  },
  { sequelize, tableName: "company_vault_recovery", timestamps: true }
);

export type RecoveryRequestStatus = "pending" | "approved" | "completed" | "cancelled";

interface RecoveryRequestAttributes {
  id: number;
  companyId: number;
  collectionId: number;
  granteeUserId: number;
  permission: "view" | "edit";
  reason: string;
  status: RecoveryRequestStatus;
  requestedBy?: number | null;
  approvedBy?: number | null;
  approvedAt?: Date | null;
  availableAt: Date;
  completedBy?: number | null;
  completedAt?: Date | null;
  cancelledBy?: number | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type RecoveryRequestCreation = Optional<
  RecoveryRequestAttributes,
  "id" | "status" | "approvedBy" | "approvedAt" | "completedBy" | "completedAt" | "cancelledBy" | "createdAt" | "updatedAt"
>;

export class RecoveryRequest
  extends Model<RecoveryRequestAttributes, RecoveryRequestCreation>
  implements RecoveryRequestAttributes
{
  public id!: number;
  public companyId!: number;
  public collectionId!: number;
  public granteeUserId!: number;
  public permission!: "view" | "edit";
  public reason!: string;
  public status!: RecoveryRequestStatus;
  public requestedBy?: number | null;
  public approvedBy?: number | null;
  public approvedAt?: Date | null;
  public availableAt!: Date;
  public completedBy?: number | null;
  public completedAt?: Date | null;
  public cancelledBy?: number | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

RecoveryRequest.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    companyId: { type: DataTypes.INTEGER, allowNull: false },
    // Empty once the vault or the person is deleted (migration 053): the request stays as history.
    collectionId: { type: DataTypes.INTEGER, allowNull: true },
    granteeUserId: { type: DataTypes.INTEGER, allowNull: true },
    permission: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "view" },
    reason: { type: DataTypes.STRING(500), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },
    requestedBy: { type: DataTypes.INTEGER, allowNull: true },
    approvedBy: { type: DataTypes.INTEGER, allowNull: true },
    approvedAt: { type: DataTypes.DATE, allowNull: true },
    availableAt: { type: DataTypes.DATE, allowNull: false },
    completedBy: { type: DataTypes.INTEGER, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    cancelledBy: { type: DataTypes.INTEGER, allowNull: true },
  },
  { sequelize, tableName: "company_recovery_requests", timestamps: true }
);

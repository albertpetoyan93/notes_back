import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface AuditEventAttributes {
  id: number;
  actorId?: number | null;
  action: string;
  noteId?: number | null;
  collectionId?: number | null;
  companyId?: number | null;
  targetUserId?: number | null;
  details: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  createdAt?: Date;
}

type AuditEventCreation = Optional<
  AuditEventAttributes,
  | "id"
  | "actorId"
  | "noteId"
  | "collectionId"
  | "companyId"
  | "targetUserId"
  | "details"
  | "ip"
  | "userAgent"
  | "createdAt"
>;

class AuditEvent
  extends Model<AuditEventAttributes, AuditEventCreation>
  implements AuditEventAttributes
{
  public id!: number;
  public actorId?: number | null;
  public action!: string;
  public noteId?: number | null;
  public collectionId?: number | null;
  public companyId?: number | null;
  public targetUserId?: number | null;
  public details!: Record<string, unknown>;
  public ip?: string | null;
  public userAgent?: string | null;
  public readonly createdAt!: Date;
}

AuditEvent.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      // Postgres returns BIGINT as a string.
      get() {
        return Number(this.getDataValue("id"));
      },
    },
    actorId: { type: DataTypes.INTEGER, allowNull: true },
    action: { type: DataTypes.STRING(50), allowNull: false },
    noteId: { type: DataTypes.INTEGER, allowNull: true },
    collectionId: { type: DataTypes.INTEGER, allowNull: true },
    companyId: { type: DataTypes.INTEGER, allowNull: true },
    targetUserId: { type: DataTypes.INTEGER, allowNull: true },
    details: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    ip: { type: DataTypes.STRING(100), allowNull: true },
    userAgent: { type: DataTypes.STRING(500), allowNull: true },
  },
  {
    sequelize,
    tableName: "audit_events",
    timestamps: true,
    updatedAt: false,
  }
);

export default AuditEvent;

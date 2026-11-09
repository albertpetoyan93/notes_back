import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type TaskStatus = "pending" | "in_progress" | "done" | "not_required" | "failed";
export type TaskKind = "rotate_credential";

interface OffboardingTaskAttributes {
  id: number;
  offboardingId: number;
  kind: TaskKind;
  noteId?: number | null;
  status: TaskStatus;
  actorId?: number | null;
  reference?: string | null;
  note?: string | null;
  updatedAt?: Date;
}

type OffboardingTaskCreation = Optional<
  OffboardingTaskAttributes,
  "id" | "kind" | "noteId" | "status" | "actorId" | "reference" | "note" | "updatedAt"
>;

class OffboardingTask
  extends Model<OffboardingTaskAttributes, OffboardingTaskCreation>
  implements OffboardingTaskAttributes
{
  public id!: number;
  public offboardingId!: number;
  public kind!: TaskKind;
  public noteId?: number | null;
  public status!: TaskStatus;
  public actorId?: number | null;
  public reference?: string | null;
  public note?: string | null;
  public readonly updatedAt!: Date;
}

OffboardingTask.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    offboardingId: { type: DataTypes.INTEGER, allowNull: false },
    kind: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "rotate_credential" },
    noteId: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: "pending" },
    actorId: { type: DataTypes.INTEGER, allowNull: true },
    reference: { type: DataTypes.STRING(200), allowNull: true },
    note: { type: DataTypes.STRING(500), allowNull: true },
  },
  {
    sequelize,
    tableName: "offboarding_tasks",
    timestamps: true,
    createdAt: false,
  }
);

export default OffboardingTask;

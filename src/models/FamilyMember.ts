import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type FamilyMemberStatus = "invited" | "active";

/** Someone an organizer invited into their Family plan (migration 036). */
interface FamilyMemberAttributes {
  id: number;
  /** The organizer: the person whose Family subscription covers everyone. */
  ownerId: number;
  /** Set once the invited email belongs to an account. */
  userId?: number | null;
  email: string;
  status: FamilyMemberStatus;
  expiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type FamilyMemberCreation = Optional<
  FamilyMemberAttributes,
  "id" | "userId" | "status" | "expiresAt" | "createdAt" | "updatedAt"
>;

class FamilyMember
  extends Model<FamilyMemberAttributes, FamilyMemberCreation>
  implements FamilyMemberAttributes
{
  public id!: number;
  public ownerId!: number;
  public userId?: number | null;
  public email!: string;
  public status!: FamilyMemberStatus;
  public expiresAt?: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

FamilyMember.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    ownerId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: true },
    email: { type: DataTypes.STRING(255), allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "invited" },
    expiresAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: "family_members", timestamps: true }
);

export default FamilyMember;

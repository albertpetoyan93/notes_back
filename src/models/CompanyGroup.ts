import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import { SharePermission } from "./NoteShare";

/**
 * Groups in companies (migration 043). A company collection can be shared with a group;
 * everyone in it gets that access, and the collection key is sealed to each of them like
 * any other member (E2EItemService.membersOf).
 */

interface CompanyGroupAttributes {
  id: number;
  companyId: number;
  name: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class CompanyGroup
  extends Model<CompanyGroupAttributes, Optional<CompanyGroupAttributes, "id" | "createdAt" | "updatedAt">>
  implements CompanyGroupAttributes
{
  public id!: number;
  public companyId!: number;
  public name!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

CompanyGroup.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    companyId: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(80), allowNull: false },
  },
  { sequelize, tableName: "company_groups", timestamps: true }
);

interface GroupMemberAttributes {
  groupId: number;
  userId: number;
  addedBy?: number | null;
  createdAt?: Date;
}

export class CompanyGroupMember
  extends Model<GroupMemberAttributes, Optional<GroupMemberAttributes, "addedBy" | "createdAt">>
  implements GroupMemberAttributes
{
  public groupId!: number;
  public userId!: number;
  public addedBy?: number | null;
  public readonly createdAt!: Date;
}

CompanyGroupMember.init(
  {
    groupId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
    userId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
    addedBy: { type: DataTypes.INTEGER, allowNull: true },
  },
  { sequelize, tableName: "company_group_members", timestamps: true, updatedAt: false }
);

interface GroupShareAttributes {
  collectionId: number;
  groupId: number;
  permission: SharePermission;
  createdAt?: Date;
  updatedAt?: Date;
}

export class CollectionGroupShare
  extends Model<GroupShareAttributes, Optional<GroupShareAttributes, "permission" | "createdAt" | "updatedAt">>
  implements GroupShareAttributes
{
  public collectionId!: number;
  public groupId!: number;
  public permission!: SharePermission;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

CollectionGroupShare.init(
  {
    collectionId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
    groupId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
    permission: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "view" },
  },
  { sequelize, tableName: "collection_group_shares", timestamps: true }
);

export type GroupRequestStatus = "open" | "approved" | "declined";

interface GroupRequestAttributes {
  id: number;
  groupId: number;
  userId: number;
  note?: string | null;
  status: GroupRequestStatus;
  decidedBy?: number | null;
  decidedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class GroupRequest
  extends Model<
    GroupRequestAttributes,
    Optional<GroupRequestAttributes, "id" | "note" | "status" | "decidedBy" | "decidedAt" | "createdAt" | "updatedAt">
  >
  implements GroupRequestAttributes
{
  public id!: number;
  public groupId!: number;
  public userId!: number;
  public note?: string | null;
  public status!: GroupRequestStatus;
  public decidedBy?: number | null;
  public decidedAt?: Date | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

GroupRequest.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    groupId: { type: DataTypes.INTEGER, allowNull: false },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    note: { type: DataTypes.STRING(500), allowNull: true },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "open" },
    decidedBy: { type: DataTypes.INTEGER, allowNull: true },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: "group_requests", timestamps: true }
);

/**
 * Models Index - Central model management
 * This file manages all models and their associations to avoid circular dependencies
 */

import sequelize from "@src/configs/DB/sequelize";

// Import all models
import User from "./User";
import Note from "./Note";
import NoteShare from "./NoteShare";
import NoteFavorite from "./NoteFavorite";
import Collection from "./Collection";
import CollectionNote from "./CollectionNote";
import CollectionShare from "./CollectionShare";
import Company from "./Company";
import CompanyMember from "./CompanyMember";
import UserSession from "./UserSession";
import UserPasskey from "./UserPasskey";
import BreachResult from "./BreachResult";
import NoteVersion from "./NoteVersion";
import SecretLink from "./SecretLink";
import AuditEvent from "./AuditEvent";
import Subscription from "./Subscription";
import TrialUsed from "./TrialUsed";
import FamilyMember from "./FamilyMember";
import DiscountRequest from "./DiscountRequest";

// Define all associations here to avoid circular dependencies
function setupAssociations() {
  // User <-> Note (one-to-many)
  User.hasMany(Note, {
    as: "notes",
    foreignKey: "userId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  Note.belongsTo(User, {
    as: "user",
    foreignKey: "userId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  // Note <-> NoteShare
  Note.hasMany(NoteShare, {
    as: "shares",
    foreignKey: "noteId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  NoteShare.belongsTo(Note, {
    as: "note",
    foreignKey: "noteId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  // User <-> NoteShare (shared by)
  User.hasMany(NoteShare, {
    as: "sharesGiven",
    foreignKey: "sharedByUserId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  NoteShare.belongsTo(User, {
    as: "sharedBy",
    foreignKey: "sharedByUserId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  // User <-> NoteShare (shared with)
  User.hasMany(NoteShare, {
    as: "sharesReceived",
    foreignKey: "sharedWithUserId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  NoteShare.belongsTo(User, {
    as: "sharedWith",
    foreignKey: "sharedWithUserId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  Note.hasMany(NoteFavorite, {
    as: "favorites",
    foreignKey: "noteId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  NoteFavorite.belongsTo(Note, {
    as: "note",
    foreignKey: "noteId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  User.hasMany(NoteFavorite, {
    as: "noteFavorites",
    foreignKey: "userId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  NoteFavorite.belongsTo(User, {
    as: "user",
    foreignKey: "userId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  User.hasMany(Collection, {
    as: "collections",
    foreignKey: "userId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  Collection.belongsTo(User, {
    as: "user",
    foreignKey: "userId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  Collection.hasMany(Note, {
    as: "notes",
    foreignKey: "collectionId",
    onUpdate: "cascade",
    onDelete: "set null",
  });

  Note.belongsTo(Collection, {
    as: "collection",
    foreignKey: "collectionId",
    onUpdate: "cascade",
    onDelete: "set null",
  });

  CollectionNote.belongsTo(Collection, {
    as: "collection",
    foreignKey: "collectionId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  CollectionNote.belongsTo(Note, {
    as: "note",
    foreignKey: "noteId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  Collection.hasMany(CollectionNote, {
    as: "noteLinks",
    foreignKey: "collectionId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  Note.hasMany(CollectionNote, {
    as: "collectionLinks",
    foreignKey: "noteId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  Collection.hasMany(CollectionShare, {
    as: "shares",
    foreignKey: "collectionId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  CollectionShare.belongsTo(Collection, {
    as: "collection",
    foreignKey: "collectionId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  User.hasMany(CollectionShare, {
    as: "collectionSharesGiven",
    foreignKey: "sharedByUserId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  CollectionShare.belongsTo(User, {
    as: "sharedBy",
    foreignKey: "sharedByUserId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  User.hasMany(CollectionShare, {
    as: "collectionSharesReceived",
    foreignKey: "sharedWithUserId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  CollectionShare.belongsTo(User, {
    as: "sharedWith",
    foreignKey: "sharedWithUserId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  Company.hasMany(CompanyMember, {
    as: "members",
    foreignKey: "companyId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  CompanyMember.belongsTo(Company, {
    as: "company",
    foreignKey: "companyId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  User.hasMany(CompanyMember, {
    as: "companyMemberships",
    foreignKey: "userId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  CompanyMember.belongsTo(User, {
    as: "user",
    foreignKey: "userId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  User.hasMany(UserSession, {
    as: "sessions",
    foreignKey: "userId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  UserSession.belongsTo(User, {
    as: "user",
    foreignKey: "userId",
    onUpdate: "cascade",
    onDelete: "cascade",
  });

  User.hasMany(UserPasskey, { foreignKey: "userId", as: "passkeys", onDelete: "CASCADE" });
  UserPasskey.belongsTo(User, { foreignKey: "userId", as: "user" });

  Note.hasMany(BreachResult, { foreignKey: "noteId", onDelete: "CASCADE" });
  BreachResult.belongsTo(Note, { foreignKey: "noteId" });

  Note.hasMany(NoteVersion, { foreignKey: "noteId", as: "versions", onDelete: "CASCADE" });
  NoteVersion.belongsTo(Note, { foreignKey: "noteId" });
  NoteVersion.belongsTo(User, { foreignKey: "changedBy", as: "author", constraints: false });

  AuditEvent.belongsTo(User, { as: "actor", foreignKey: "actorId", constraints: false });
  AuditEvent.belongsTo(User, { as: "target", foreignKey: "targetUserId", constraints: false });
}

// Export default object with all models
export default {
  sequelize,
  User,
  Note,
  NoteShare,
  NoteFavorite,
  Collection,
  CollectionShare,
  Company,
  CompanyMember,
  UserSession,
  UserPasskey,
  BreachResult,
  NoteVersion,
  SecretLink,
  AuditEvent,
  Subscription,
  TrialUsed,
  FamilyMember,
  DiscountRequest,
  setupAssociations,
};

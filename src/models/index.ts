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
import CollectionShare from "./CollectionShare";
import Company from "./Company";
import CompanyMember from "./CompanyMember";

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
  setupAssociations,
};

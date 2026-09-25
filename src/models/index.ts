/**
 * Models Index - Central model management
 * This file manages all models and their associations to avoid circular dependencies
 */

import sequelize from "@src/configs/DB/sequelize";

// Import all models
import User from "./User";
import Note from "./Note";
import NoteShare from "./NoteShare";

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
}

// Export default object with all models
export default {
  sequelize,
  User,
  Note,
  NoteShare,
  setupAssociations,
};

/**
 * Models Index - Central model management
 * This file manages all models and their associations to avoid circular dependencies
 */

import sequelize from "@src/configs/DB/sequelize";

// Import all models
import User from "./User";
import Note from "./Note";

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
}

// Export default object with all models
export default {
  sequelize,
  User,
  Note,
  setupAssociations,
};

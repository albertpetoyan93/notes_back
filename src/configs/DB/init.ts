import logger from "jet-logger";
import sequelize from "./sequelize";
import models from "../../models";

/**
 * Initialize database connections and associations
 */
export async function initializeDatabase(): Promise<void> {
  try {
    // Setup model associations first
    models.setupAssociations();
    logger.info("Database associations setup completed");

    // Test database connection
    await sequelize.authenticate();
    logger.info("Database connection established successfully");
  } catch (error) {
    logger.err("Unable to initialize database:", error);
    logger.err(`Error message: ${error.message}`);
    logger.err(`Error stack: ${error.stack}`);
    throw error;
  }
}

export default initializeDatabase;

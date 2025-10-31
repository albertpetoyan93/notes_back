import EnvVars from "@src/common/EnvVars";
import http from "http";
import logger from "jet-logger";
import sequelize from "./configs/DB/sequelize";
import app from "./server";
import socketService from "./services/SocketManager";
import initializeDatabase from "./configs/DB/init";

// **** Run **** //

const SERVER_START_MSG =
  "Express server started on port: " + EnvVars.Port.toString();

export const server = http.createServer(app);

// Initialize socket service
socketService.initialize(server);

async function start() {
  try {
    // Initialize database (setup associations and test connection)
    await initializeDatabase();

    // Start HTTP server
    server.listen(EnvVars.Port, () => {
      logger.info(SERVER_START_MSG);
    });

    logger.info("Enhanced DB polling system started");

    // Setup graceful shutdown
    setupGracefulShutdown();
  } catch (error) {
    logger.err("Failed to start server:", error);
    process.exit(1);
  }
}

/**
 * Setup graceful shutdown handling
 */
function setupGracefulShutdown(): void {
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);

    // Close HTTP server
    server.close(() => {
      logger.info("HTTP server closed");

      // Close database connection
      sequelize
        .close()
        .then(() => {
          logger.info("Database connection closed");
          process.exit(0);
        })
        .catch((error) => {
          logger.err("Error closing database connection:", error);
          process.exit(1);
        });
    });

    // Force exit after timeout
    setTimeout(() => {
      logger.err("Forced shutdown after timeout");
      process.exit(1);
    }, 10000);
  };

  // Handle different shutdown signals
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGUSR2", () => shutdown("SIGUSR2")); // For nodemon

  // Handle uncaught exceptions
  process.on("uncaughtException", (error) => {
    logger.err(`Uncaught Exception: ${error.message}`);
    shutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.err(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    shutdown("unhandledRejection");
  });
}

start();

import EnvVars from "@src/common/EnvVars";
import http from "http";
import logger from "jet-logger";
import sequelize from "./configs/DB/sequelize";
import app from "./server";
import initializeDatabase from "./configs/DB/init";
import { assertEncryptionReady } from "./util/encryption";
import JobService from "./services/JobService";
import { registerBillingJobs } from "./services/BillingJobs";
import { registerAnalyticsJobs } from "./services/AnalyticsJobs";
import { registerEmailVerificationJobs } from "./services/EmailVerificationJobs";

// **** Run **** //

const SERVER_START_MSG =
  "Express server started on port: " + EnvVars.Port.toString();

export const server = http.createServer(app);

async function start() {
  try {
    // Refuse to start without a usable ENCRYPTION_KEY in production.
    assertEncryptionReady();

    // Initialize database (setup associations and test connection)
    await initializeDatabase();

    // Start HTTP server. Wait for the port: if it is taken, stop here (exit 1)
    // instead of starting jobs and then shutting down as a "clean exit".
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(EnvVars.Port, () => {
        server.off("error", reject);
        resolve();
      });
    });
    logger.info(SERVER_START_MSG);

    logger.info("Enhanced DB polling system started");

    // Daily jobs (trial reminders and expiry), once a day, never twice.
    registerBillingJobs();
    registerAnalyticsJobs();
    registerEmailVerificationJobs();
    JobService.start();

    // Setup graceful shutdown
    setupGracefulShutdown();
  } catch (error: any) {
    if (error?.code === "EADDRINUSE") {
      logger.err(`Failed to start server: port ${EnvVars.Port} is already in use (another backend still running?)`);
    } else {
      logger.err(`Failed to start server: ${error?.stack || error}`);
    }
    process.exit(1);
  }
}

/**
 * Setup graceful shutdown handling
 */
function setupGracefulShutdown(): void {
  // A crash exits 1 so nodemon and process managers don't report it as a clean exit.
  const shutdown = async (signal: string, exitCode = 0) => {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);

    // Close HTTP server
    server.close(() => {
      logger.info("HTTP server closed");

      // Close database connection
      sequelize
        .close()
        .then(() => {
          logger.info("Database connection closed");
          process.exit(exitCode);
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
    shutdown("uncaughtException", 1);
  });

  process.on("unhandledRejection", (reason, promise) => {
    logger.err(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    shutdown("unhandledRejection", 1);
  });
}

start();

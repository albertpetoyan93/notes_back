import EnvVars from "@src/common/EnvVars";
import { NodeEnvs } from "@src/common/misc";
import cookieParser from "cookie-parser";
import express, { NextFunction, Request, Response } from "express";
import "express-async-errors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import swaggerUi from "swagger-ui-express";
import headers from "./middlwares/headers";
import indexRouter from "./routes/index";
const swaggerDocument = require("@src/views/swagger-output.json");
// "dev": "npx ts-node ./src/index.ts --env=production",

// **** Variables **** //

const app = express();

app.use("/doc", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// **** Setup **** //

// Basic middleware
app.use(express.json());
app.use(headers);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(EnvVars.CookieProps.Secret));

// Show routes called in console during development
if (EnvVars.NodeEnv === NodeEnvs.Dev.valueOf()) {
  app.use(morgan("dev"));
}

// Security
if (EnvVars.NodeEnv === NodeEnvs.Production.valueOf()) {
  app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
    })
  );
}

// Add APIs, must be after middleware
app.use("/api", indexRouter);

// Add error handler
app.use((err: any, _: Request, res: Response, next: NextFunction) => {
  res.status(err.status || 500).json({
    status: err.status || 500,
    message: err.message || "Server error",
  });
});

// **** Front-End Content **** //

// Set static directory (js and css).
const staticDir =
  process.env.NODE_ENV === "production"
    ? path.join(__dirname, "../src/public")
    : path.join(__dirname, "public");

app.use(express.static(staticDir));

// **** Export default **** //

export default app;

import EnvVars from "@src/common/EnvVars";
import { NodeEnvs } from "@src/common/misc";
import "./../pre-start";

const swaggerAutogen = require("swagger-autogen")({
  autoHeaders: true,
  autoQuery: true,
  autoBody: true,
  writeOutputFile: true,
});
const host =
  EnvVars.NodeEnv === NodeEnvs.Production.valueOf()
    ? "phpstack-1183027-4754640.cloudwaysapps.com"
    : "localhost:5001";

const doc = {
  info: {
    version: "v1.0.0",
    title: "Chat",
    description: "Implementation of Swagger with TypeScript",
  },
  host: host,
  basePath: "/",
  securityDefinitions: {
    // securitySchemes: {
    //   bearerAuth: {
    //     type: "http",
    //     scheme: "bearer",
    //   },
    // },
    apiKey: {
      type: "apiKey",
      in: "header",
      name: "Authorization",
      description: "Some description...",
    },
  },
  tags: [],
  schemes: ["http", "https"],
  consumes: ["application/json"],
  produces: ["application/json"],
};

const outputFile = "../view/swagger-output.json";
const endpointsFiles = ["./src/routes/index.ts"];

swaggerAutogen(outputFile, endpointsFiles, doc);
export default swaggerAutogen(outputFile, endpointsFiles, doc);

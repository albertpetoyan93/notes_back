/* eslint-disable */
const fs = require("fs");
const path = require("path");

const appDir = __dirname;

function fail(message) {
  console.error(`[notes-backend] ${message}`);
  process.exit(1);
}

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "production";
}

const envFile = path.join(appDir, "env", `${process.env.NODE_ENV}.env`);
const entryFile = path.join(appDir, "dist", "index.js");

if (!fs.existsSync(envFile)) {
  fail(
    `Missing env file: ${envFile}\nCopy env/production.env and set your server values.`
  );
}

if (!fs.existsSync(entryFile)) {
  fail(`Missing build output: ${entryFile}\nRun: npm install && npm run build`);
}

try {
  require("./preload.js");
} catch (err) {
  fail(`Preload failed: ${err.message}`);
}

try {
  require("./dist/index.js");
} catch (err) {
  fail(`Server failed to start: ${err.message}\n${err.stack || ""}`);
}

const path = require("path");

const appDir = __dirname;

module.exports = {
  apps: [
    {
      name: "notes-backend",
      script: path.join(appDir, "start-prod.js"),
      cwd: appDir,
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: 5000,
      env: {
        NODE_ENV: "production",
        PORT: 9000,
      },
    },
  ],
};

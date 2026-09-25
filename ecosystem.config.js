module.exports = {
  apps: [
    {
      name: "notes-backend",
      script: "npm",
      args: "start",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 9000,
      },
    },
  ],
};

/* eslint-disable n/no-process-env */

export default {
  NodeEnv: process.env.NODE_ENV ?? "",
  Port: process.env.PORT ?? 0,
  CookieProps: {
    Key: "ExpressGeneratorTs",
    Secret: process.env.COOKIE_SECRET ?? "",
    // Casing to match express cookie options
    Options: {
      httpOnly: true,
      signed: true,
      path: process.env.COOKIE_PATH ?? "",
      maxAge: Number(process.env.COOKIE_EXP ?? 0),
      domain: process.env.COOKIE_DOMAIN ?? "",
      secure: process.env.SECURE_COOKIE === "true",
    },
  },
  Jwt: {
    Secret: process.env.JWT_SECRET ?? "",
    Exp: process.env.COOKIE_EXP ?? "", // exp at the same time as the cookie
  },
  Db: {
    Host: process.env.DB_HOST ?? "",
    Port: process.env.DB_PORT ?? "",
    User: process.env.DB_USER ?? "",
    Password: process.env.DB_PASSWORD ?? "",
    Database: process.env.DB_NAME ?? "",
  },
  Slack: {
    BotToken: process.env.SLACK_BOT_TOKEN ?? "",
    ChannelId: process.env.SLACK_CHANNEL_ID ?? "",
  },
  Polling: {
    Interval: Number(process.env.POLLING_INTERVAL ?? 5000),
    LookbackWindow: Number(process.env.LOOKBACK_WINDOW ?? 300000), // 5 minutes in ms
    MaxRetries: Number(process.env.MAX_RETRIES ?? 3),
    BackoffMultiplier: Number(process.env.BACKOFF_MULTIPLIER ?? 2),
    MaxBackoff: Number(process.env.MAX_BACKOFF ?? 60000), // 1 minute max backoff
  },
} as const;

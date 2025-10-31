import { WebClient } from "@slack/web-api";
import EnvVars from "@src/common/EnvVars";

export const slack = new WebClient(EnvVars.Slack.BotToken);

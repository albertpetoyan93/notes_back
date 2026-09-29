import JWT, { JwtPayload } from "jsonwebtoken";
import EnvVars from "@src/common/EnvVars";

const { Secret } = EnvVars.Jwt;

export const tokenVerify = (token?: string): JwtPayload => {
  if (!token) {
    return { userId: null };
  }

  const data = JWT.verify(token, Secret);
  if (typeof data === "string") {
    return { userId: null };
  }

  return data;
};

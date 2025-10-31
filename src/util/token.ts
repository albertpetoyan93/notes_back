import JWT from "jsonwebtoken";
import EnvVars from "@src/common/EnvVars";

const { Secret } = EnvVars.Jwt;

export const tokenGenerator = (data = {}, type: string) => {
  const expiresIn =
    type === "access"
      ? process.env.ACCESS_TOKEN_EXPIRES
      : process.env.REFRESH_TOKEN_EXPIRES;

  const token = JWT.sign(data, Secret, { expiresIn });

  return token;
};

export const tokenVerify = (hash?: string) => {
  const token = hash?.split(" ")[1] as string;
  if (!token) {
    return { userId: null };
  }
  // const data: any = JWT.verify(token, "");
  const data: any = JWT.decode(token, { complete: true });
  return data?.payload;
};

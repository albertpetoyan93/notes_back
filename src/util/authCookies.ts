import { CookieOptions, Response } from "express";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";

export const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
export const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function baseOptions(): CookieOptions {
  const options: CookieOptions = {
    httpOnly: true,
    secure: process.env.SECURE_COOKIE === "true",
    sameSite: "lax",
  };

  const domain = process.env.COOKIE_DOMAIN;
  if (domain && domain !== "localhost") {
    options.domain = domain;
  }

  return options;
}

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string
) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseOptions(),
    maxAge: ACCESS_MAX_AGE_MS,
    path: "/",
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseOptions(),
    maxAge: REFRESH_MAX_AGE_MS,
    path: "/api/auth",
  });
}

export function clearAuthCookies(res: Response) {
  const options = baseOptions();
  res.clearCookie(ACCESS_COOKIE, { ...options, path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...options, path: "/api/auth" });
}

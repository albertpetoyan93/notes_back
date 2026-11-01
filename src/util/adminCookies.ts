import { CookieOptions, Response } from "express";
import { ADMIN_MAX_MS } from "../services/SessionService";
import { ACCESS_MAX_AGE_MS } from "./authCookies";

export const ADMIN_ACCESS_COOKIE = "admin_access";
export const ADMIN_REFRESH_COOKIE = "admin_refresh";

const ACCESS_PATH = "/api/admin";
const REFRESH_PATH = "/api/admin/auth";

// No domain: the admin cookies stay on the API host and never reach the vault's subdomains.
function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.SECURE_COOKIE === "true",
    sameSite: "strict",
  };
}

export function setAdminCookies(res: Response, accessToken: string, refreshToken: string | null) {
  res.cookie(ADMIN_ACCESS_COOKIE, accessToken, {
    ...baseOptions(),
    maxAge: ACCESS_MAX_AGE_MS,
    path: ACCESS_PATH,
  });
  if (!refreshToken) return;
  res.cookie(ADMIN_REFRESH_COOKIE, refreshToken, {
    ...baseOptions(),
    maxAge: ADMIN_MAX_MS,
    path: REFRESH_PATH,
  });
}

export function clearAdminCookies(res: Response) {
  const options = baseOptions();
  res.clearCookie(ADMIN_ACCESS_COOKIE, { ...options, path: ACCESS_PATH });
  res.clearCookie(ADMIN_REFRESH_COOKIE, { ...options, path: REFRESH_PATH });
}

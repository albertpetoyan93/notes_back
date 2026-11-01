import type { Request as ExpressRequest } from "express";
import type { StaffRole } from "./models/AdminStaff";

export interface AuthRequest extends Request {
  user?: {
    id: number;
    username: string;
    sessionId?: number;
  };
  query: any;
  params: any;
  body: any;
}

/** Set by isStaff on admin routes. */
export interface StaffRequest extends ExpressRequest {
  staff?: {
    userId: number;
    email: string;
    role: StaffRole;
    sessionId: number;
  };
}

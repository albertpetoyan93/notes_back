import { Request } from "express";

export interface AuthRequest extends Request {
  user?: {
    id: number;
    userId?: number;
    username?: string;
    role?: string;
  };
}

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

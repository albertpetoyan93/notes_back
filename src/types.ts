export interface AuthRequest extends Request {
  user?: {
    id: number;
    username: string;
  };
  query: any;
  params: any;
  body: any;
}

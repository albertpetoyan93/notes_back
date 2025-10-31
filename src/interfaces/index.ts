import * as e from "express";

export interface ILogin {
  login: string;
  password: string;
}

export interface IPagination {
  limit?: number;
  offset?: number;
}

export interface IAuthRequest extends e.Request {
  user: IToken;
}

export interface IFile {
  mimetype: string;
  url: string;
  name: string;
}

export interface ISingle {
  id?: string;
}

export interface IToken {
  userId: string;
  activeRole: string;
  roles?: string[];
}

export interface IList {
  order: string;
  sortKey: string;
  filter: any;
  limit: number;
  page: number;
  fields?: any;
}

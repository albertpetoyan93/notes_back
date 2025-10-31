import { IPagination } from ".";

export interface IMessage {
  id: string;
  message?: string;
  files?: string[];
  sender?: string;
  seen?: boolean;
  tokenId: string;
  chat_id: string;
  reaction: string;
}

export interface IMessageList extends IPagination {
  productId: string;
}

export interface IMessageListByChatId extends IPagination {
  chat_id: string;
}

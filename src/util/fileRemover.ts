// import { ImageExtensions, ImageMimetypes } from "../constants/Enums";
// import HttpStatusCodes from "../constants/HttpStatusCodes";
// import Message from "../models/Message";
// import CustomError from "./CustomError";

export const fileRemover = async (filePath: string) => {
  try {
    // const message = await Message.update(
    //   { "files.url": filePath },
    //   { $pull: { files: { url: filePath } } },
    // );
  } catch (e) {
    console.log(e);
  }
};

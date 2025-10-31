// import multer from "multer";
import { mkdir } from "../util/mkdir";

export const multerMiddleware = () => {
  // return multer({
  //   storage: multer.diskStorage({
  //     destination: (req: any, file: any, cb: any) => {
  //       cb(null, mkdir());
  //     },
  //     filename: (req: any, file: any, cb: any) => {
  //       const fileName = `${Date.now()}-${Buffer.from(
  //         file.originalname,
  //         "latin1"
  //       )
  //         .toString("utf8")
  //         .replace(/ /g, "-")}`;
  //       cb(null, fileName);
  //     },
  //   }),
  //   limits: {
  //     fileSize: 5 * 1024 * 1024,
  //   },
  // });
};

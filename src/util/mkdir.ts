import moment from "moment";
import CustomError from "./CustomError";
const fs = require("fs");
const path = require("path");

export const mkdir = () => {
  try {
    const today = moment().format("YYYY-MM-DD");
    const destinationDir = path.join("src/public/files", today);
    if (!fs.existsSync(destinationDir)) {
      fs.mkdirSync(destinationDir);
    }
    return destinationDir;
  } catch (e) {
    throw new CustomError(e.message, e.status);
  }
};

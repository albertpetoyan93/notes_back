import { NextFunction, Response, Request } from "express";

const validate =
  (schema: any) => async (req: any, res: Response, next: NextFunction) => {
    try {
      await schema.validate({
        body: req.body,
        headers: req.headers,
        query: req?.query,
        params: req?.params,
        files: req?.files,
        file: req?.file,
        user: req?.user,
      });
      return next();
    } catch (e) {
      return res.status(500).json({ type: e.name, message: e.message });
    }
  };
export default validate;

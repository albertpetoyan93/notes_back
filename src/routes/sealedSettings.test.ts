import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/middlwares/isAuth", () => ({
  default: (req: any, res: any, next: any) => {
    if (!req.get("x-test-user")) return res.status(401).end();
    req.user = { userId: Number(req.get("x-test-user")) };
    next();
  },
}));
vi.mock("@src/configs/DB/sequelize", () => ({ default: { query: vi.fn() } }));

import sequelize from "@src/configs/DB/sequelize";
import sealedSettings from "./sealedSettings";

const query = sequelize.query as unknown as ReturnType<typeof vi.fn>;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/sealed-settings", sealedSettings);
  return a;
}

const TOKEN = "e2e1.AbC-_123.ZZZ_-abc";

describe("/api/sealed-settings", () => {
  beforeEach(() => query.mockReset());

  it("needs a signed-in user", async () => {
    await request(app()).get("/api/sealed-settings").expect(401);
  });

  it("returns only the signed-in user's token", async () => {
    query.mockResolvedValue([{ sealedSettings: TOKEN }]);
    const res = await request(app()).get("/api/sealed-settings").set("x-test-user", "7").expect(200);
    expect(res.body).toEqual({ sealedSettings: TOKEN });
    expect(query.mock.calls[0][1].replacements).toEqual({ id: 7 });
  });

  it("stores an encrypted token or null", async () => {
    query.mockResolvedValue([]);
    await request(app()).put("/api/sealed-settings").set("x-test-user", "7").send({ sealedSettings: TOKEN }).expect(204);
    expect(query.mock.calls[0][1].replacements).toEqual({ id: 7, value: TOKEN });
    await request(app()).put("/api/sealed-settings").set("x-test-user", "7").send({ sealedSettings: null }).expect(204);
  });

  it("refuses plain text, other shapes and oversize values", async () => {
    for (const value of ['{"dismissed":["tower.jp"]}', "hello", 42, `e2e1.${"a".repeat(70000)}.b`]) {
      await request(app()).put("/api/sealed-settings").set("x-test-user", "7").send({ sealedSettings: value }).expect(400);
    }
    expect(query).not.toHaveBeenCalled();
  });
});

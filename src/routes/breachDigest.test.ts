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
vi.mock("@src/services/BreachDigestService", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, default: { isOn: vi.fn(async () => false), set: vi.fn(async () => undefined) } };
});
vi.mock("@src/configs/DB/sequelize", () => ({ default: { query: vi.fn() } }));

import BreachDigestService, { unsubscribeToken } from "@src/services/BreachDigestService";
import breachDigest from "./breachDigest";

const set = BreachDigestService.set as unknown as ReturnType<typeof vi.fn>;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/breach-digest", breachDigest);
  return a;
}

describe("/api/breach-digest", () => {
  beforeEach(() => set.mockClear());

  it("reads and sets the switch for the signed-in user only", async () => {
    await request(app()).get("/api/breach-digest").expect(401);
    const res = await request(app()).get("/api/breach-digest").set("x-test-user", "5").expect(200);
    expect(res.body).toEqual({ enabled: false });
    await request(app()).put("/api/breach-digest").set("x-test-user", "5").send({ enabled: true }).expect(200);
    expect(set).toHaveBeenCalledWith(5, true);
    await request(app()).put("/api/breach-digest").set("x-test-user", "5").send({ enabled: "yes" }).expect(400);
  });

  it("turns it off from the email link with a valid token, without signing in", async () => {
    const res = await request(app()).get(`/api/breach-digest/unsubscribe?u=9&t=${unsubscribeToken(9)}`).expect(200);
    expect(res.text).toContain("won't get breach emails");
    expect(set).toHaveBeenCalledWith(9, false);
    await request(app()).post(`/api/breach-digest/unsubscribe?u=9&t=${unsubscribeToken(9)}`).expect(200);
  });

  it("refuses a wrong or borrowed token", async () => {
    await request(app()).get(`/api/breach-digest/unsubscribe?u=10&t=${unsubscribeToken(9)}`).expect(400);
    await request(app()).get("/api/breach-digest/unsubscribe?u=9&t=abc").expect(400);
    expect(set).not.toHaveBeenCalled();
  });
});

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@src/services/TrafficService", () => ({ default: { record: vi.fn(async () => true) } }));

import TrafficService from "@src/services/TrafficService";
import pv from "./pv";

const record = TrafficService.record as unknown as ReturnType<typeof vi.fn>;

function app() {
  const a = express();
  a.set("trust proxy", 1);
  a.use(express.json());
  a.use("/api/pv", pv);
  return a;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36";

describe("POST /api/pv", () => {
  beforeEach(() => record.mockClear());

  it("reads a sendBeacon text/plain body and answers 204", async () => {
    const res = await request(app())
      .post("/api/pv")
      .set("content-type", "text/plain")
      .set("user-agent", UA)
      .set("x-forwarded-for", "203.0.113.7")
      .send(JSON.stringify({ p: "/", tz: "Europe/Paris" }));
    expect(res.status).toBe(204);
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith({ p: "/", tz: "Europe/Paris" }, "203.0.113.7", UA));
  });

  it("accepts a JSON body too", async () => {
    await request(app()).post("/api/pv").set("user-agent", UA).send({ p: "/pricing" }).expect(204);
    await vi.waitFor(() => expect(record).toHaveBeenCalledWith({ p: "/pricing" }, expect.any(String), UA));
  });

  it("does not count visitors with Do Not Track or Global Privacy Control", async () => {
    await request(app()).post("/api/pv").set("dnt", "1").send({ p: "/" }).expect(204);
    await request(app()).post("/api/pv").set("sec-gpc", "1").send({ p: "/" }).expect(204);
    expect(record).not.toHaveBeenCalled();
  });

  it("ignores a body that isn't JSON", async () => {
    await request(app()).post("/api/pv").set("content-type", "text/plain").send("not json").expect(204);
    expect(record).not.toHaveBeenCalled();
  });
});

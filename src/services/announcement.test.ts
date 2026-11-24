import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../configs/DB/sequelize", () => ({ default: { query: vi.fn() } }));
vi.mock("./EmailService", () => ({ default: { isConfigured: vi.fn(() => true), sendAnnouncement: vi.fn() } }));

import sequelize from "../configs/DB/sequelize";
import productNews from "../routes/productNews";
import AnnouncementService, { activeCampaign, checkNewsToken, newsToken } from "./AnnouncementService";
import EmailService from "./EmailService";

const query = sequelize.query as unknown as ReturnType<typeof vi.fn>;
const send = EmailService.sendAnnouncement as unknown as ReturnType<typeof vi.fn>;
const users = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, email: `u${i + 1}@x.test` }));

describe("AnnouncementService", () => {
  beforeEach(() => {
    query.mockReset();
    send.mockReset();
  });

  it("is off unless ANNOUNCEMENT names a known campaign", async () => {
    expect(activeCampaign("")).toBeNull();
    expect(activeCampaign("spam-everyone")).toBeNull();
    expect(activeCampaign(" breach-alerts ")).toBe("breach-alerts");
    expect(await AnnouncementService.run(null)).toEqual({ campaign: null, sent: 0, more: false });
    expect(query).not.toHaveBeenCalled();
  });

  it("sends one batch to confirmed, opted-in users who don't have it yet, and records each send", async () => {
    query.mockResolvedValueOnce(users(4)).mockResolvedValue(undefined);
    const result = await AnnouncementService.run("breach-alerts", 3);
    expect(result).toEqual({ campaign: "breach-alerts", sent: 3, more: true });
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain(`"emailVerifiedAt" IS NOT NULL`);
    expect(sql).toContain(`"productNews" = TRUE`);
    expect(sql).toContain(`NOT EXISTS`);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0].unsubscribeUrl).toContain("/api/product-news/unsubscribe?u=1&t=");
    const inserts = query.mock.calls.filter(([s]) => String(s).startsWith(`INSERT INTO "announcement_sends"`));
    expect(inserts.map(([, o]) => o.replacements.id)).toEqual([1, 2, 3]);
  });

  it("stops at the first failed send (daily limit) without recording it", async () => {
    query.mockResolvedValueOnce(users(3)).mockResolvedValue(undefined);
    send.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("limit"));
    const result = await AnnouncementService.run("breach-alerts", 10);
    expect(result).toEqual({ campaign: "breach-alerts", sent: 1, more: true });
    expect(query.mock.calls.filter(([s]) => String(s).startsWith("INSERT")).length).toBe(1);
  });

  it("reports nothing more once everyone has it", async () => {
    query.mockResolvedValueOnce(users(2)).mockResolvedValue(undefined);
    expect(await AnnouncementService.run("breach-alerts", 10)).toEqual({ campaign: "breach-alerts", sent: 2, more: false });
  });
});

describe("/api/product-news/unsubscribe", () => {
  const app = () => express().use("/api/product-news", productNews);
  beforeEach(() => query.mockReset().mockResolvedValue(undefined));

  it("turns product news off with a valid token, GET or one-click POST", async () => {
    const res = await request(app()).get(`/api/product-news/unsubscribe?u=7&t=${newsToken(7)}`).expect(200);
    expect(res.text).toContain("won't get product news");
    expect(query.mock.calls[0][1].replacements).toEqual({ userId: 7, on: false });
    await request(app()).post(`/api/product-news/unsubscribe?u=7&t=${newsToken(7)}`).expect(200);
  });

  it("refuses a wrong or borrowed token", async () => {
    await request(app()).get(`/api/product-news/unsubscribe?u=8&t=${newsToken(7)}`).expect(400);
    await request(app()).get("/api/product-news/unsubscribe?u=7&t=abc").expect(400);
    expect(query).not.toHaveBeenCalled();
    expect(checkNewsToken(7, newsToken(7))).toBe(true);
  });
});

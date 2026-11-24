import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../configs/DB/sequelize", () => ({ default: { query: vi.fn() } }));
vi.mock("./EmailService", () => ({ default: { isConfigured: vi.fn(() => true), sendBreachDigest: vi.fn() } }));
vi.mock("./BreachFeedService", () => ({ default: { list: vi.fn() } }));

import sequelize from "../configs/DB/sequelize";
import BreachDigestService, { checkUnsubscribeToken, pickBreaches, unsubscribeToken } from "./BreachDigestService";
import BreachFeedService from "./BreachFeedService";
import EmailService from "./EmailService";

const query = sequelize.query as unknown as ReturnType<typeof vi.fn>;
const send = EmailService.sendBreachDigest as unknown as ReturnType<typeof vi.fn>;
const list = BreachFeedService.list as unknown as ReturnType<typeof vi.fn>;

const NOW = new Date("2026-11-30T05:00:00Z");
const b = (name: string, addedDate: string, pwnCount = 5_000_000, isVerified = true) => ({
  name,
  title: name,
  domain: `${name.toLowerCase()}.com`,
  breachDate: "2026-11-20",
  addedDate,
  pwnCount,
  dataClasses: ["Email addresses", "Passwords"],
  isVerified,
});

describe("pickBreaches", () => {
  it("keeps big, verified breaches added since the last email, newest first", () => {
    const feed = [
      b("Old", "2026-11-01T00:00:00Z"),
      b("Small", "2026-11-25T00:00:00Z", 20_000),
      b("Unverified", "2026-11-25T00:00:00Z", 9_000_000, false),
      b("Big", "2026-11-26T00:00:00Z"),
      b("Bigger", "2026-11-28T00:00:00Z"),
    ];
    expect(pickBreaches(feed, new Date("2026-11-23T00:00:00Z")).map((x) => x.name)).toEqual(["Bigger", "Big"]);
  });
});

describe("unsubscribe token", () => {
  it("only works for the user it was made for", () => {
    const token = unsubscribeToken(7);
    expect(checkUnsubscribeToken(7, token)).toBe(true);
    expect(checkUnsubscribeToken(8, token)).toBe(false);
    expect(checkUnsubscribeToken(7, "nope")).toBe(false);
    expect(checkUnsubscribeToken(Number.NaN, token)).toBe(false);
  });
});

describe("BreachDigestService.run", () => {
  beforeEach(() => {
    query.mockReset();
    send.mockReset();
    list.mockReset();
    (EmailService.isConfigured as any).mockReturnValue(true);
  });

  it("emails users who are due, moves their date, and skips the email when nothing is new", async () => {
    query.mockResolvedValueOnce([
      { id: 1, email: "a@example.test", breachDigestAt: "2026-11-22T05:00:00Z" },
      { id: 2, email: "b@example.test", breachDigestAt: "2026-11-29T00:00:00Z" },
    ]);
    query.mockResolvedValue([]);
    list.mockResolvedValue([b("Big", "2026-11-26T00:00:00Z")]);
    send.mockResolvedValue(true);

    const result = await BreachDigestService.run(NOW);

    expect(result).toEqual({ due: 2, sent: 1, empty: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].to).toBe("a@example.test");
    expect(send.mock.calls[0][0].breaches.map((x: any) => x.name)).toEqual(["Big"]);
    expect(send.mock.calls[0][0].unsubscribeUrl).toContain("/api/breach-digest/unsubscribe?u=1&t=");
    // Both users' dates moved to now (one emailed, one had nothing new).
    const updates = query.mock.calls.filter(([sql]) => String(sql).startsWith(`UPDATE "users" SET "breachDigestAt"`));
    expect(updates.map(([, opts]) => opts.replacements.id).sort()).toEqual([1, 2]);
  });

  it("stops at the first failed send so account emails keep their quota", async () => {
    query.mockResolvedValueOnce([
      { id: 1, email: "a@example.test", breachDigestAt: null },
      { id: 2, email: "b@example.test", breachDigestAt: null },
    ]);
    query.mockResolvedValue([]);
    list.mockResolvedValue([b("Big", "2026-11-26T00:00:00Z")]);
    send.mockRejectedValueOnce(new Error("limit"));

    const result = await BreachDigestService.run(NOW);

    expect(result.sent).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does nothing when email isn't configured", async () => {
    (EmailService.isConfigured as any).mockReturnValue(false);
    expect(await BreachDigestService.run(NOW)).toEqual({ due: 0, sent: 0, empty: 0 });
    expect(query).not.toHaveBeenCalled();
  });
});

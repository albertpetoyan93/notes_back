import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../configs/DB/sequelize", () => ({
  default: { query: vi.fn() },
}));
vi.mock("../../models/MetricsDaily", () => ({
  default: { upsert: vi.fn() },
}));
vi.mock("../../models/Subscription", () => ({
  default: { findAll: vi.fn() },
}));
vi.mock("../../models/Company", () => ({
  default: { findAll: vi.fn() },
}));
vi.mock("../EntitlementService", () => ({
  isLive: () => true,
}));

import sequelize from "../../configs/DB/sequelize";
import MetricsDaily from "../../models/MetricsDaily";
import Subscription from "../../models/Subscription";
import Company from "../../models/Company";
import { snapshot, yesterdayUtc } from "./MetricsDailyService";

const query = vi.mocked(sequelize.query);
const upsert = vi.mocked(MetricsDaily.upsert);
const findSubs = vi.mocked(Subscription.findAll);
const findCompanies = vi.mocked(Company.findAll);

describe("MetricsDailyService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // sequelize.query is heavily overloaded; the fake only needs the raw-rows shape.
    query.mockImplementation((async (sql: unknown) => {
      const text = String(sql);
      if (text.includes("user_activity_days")) {
        return [{ dau: "3", wau: "5", mau: "9" }];
      }
      return [
        {
          signups: "2",
          churned: "1",
          activatedFirstItem: "1",
          activatedExtension: "0",
          activatedAutofill: "0",
        },
      ];
    }) as never);
    findSubs.mockResolvedValue([]);
    findCompanies.mockResolvedValue([]);
    upsert.mockResolvedValue([{} as never, true]);
  });

  it("upserts a snapshot for the day", async () => {
    const row = await snapshot("2026-10-30");
    expect(row).toMatchObject({
      date: "2026-10-30",
      signups: 2,
      dau: 3,
      wau: 5,
      mau: 9,
      churned: 1,
      activatedFirstItem: 1,
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-10-30", dau: 3 }));
  });

  it("yesterdayUtc is one day before today", () => {
    expect(yesterdayUtc(new Date("2026-10-31T12:00:00Z"))).toBe("2026-10-30");
  });
});

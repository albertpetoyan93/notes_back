import { describe, expect, it } from "vitest";
import { cleanBreaches, rootHost } from "./BreachFeedService";

const base = {
  Name: "TowerRecords",
  Title: "Tower Records Japan",
  Domain: "tower.jp",
  BreachDate: "2026-11-19",
  AddedDate: "2026-11-22T10:00:00Z",
  PwnCount: 11000000,
  DataClasses: ["Email addresses", "Passwords"],
  IsVerified: true,
  IsFabricated: false,
  IsSpamList: false,
  IsRetired: false,
  IsMalware: false,
};

describe("rootHost", () => {
  it("keeps the part people sign in to, like the extension", () => {
    expect(rootHost("www.shop.example.com")).toBe("example.com");
    expect(rootHost("https://login.tower.co.jp/path?x=1")).toBe("tower.co.jp");
    expect(rootHost("bbc.co.uk")).toBe("bbc.co.uk");
    expect(rootHost("Example.COM.")).toBe("example.com");
    expect(rootHost("localhost")).toBe("localhost");
  });
});

describe("cleanBreaches", () => {
  it("keeps password breaches with a domain, normalised", () => {
    expect(cleanBreaches([{ ...base, Domain: "www.tower.jp" }])).toEqual([
      {
        name: "TowerRecords",
        title: "Tower Records Japan",
        domain: "tower.jp",
        breachDate: "2026-11-19",
        addedDate: "2026-11-22T10:00:00.000Z",
        pwnCount: 11000000,
        dataClasses: ["Email addresses", "Passwords"],
        isVerified: true,
      },
    ]);
  });

  it("keeps big email-only breaches but drops small ones", () => {
    const emailsOnly = { ...base, DataClasses: ["Email addresses", "Names"] };
    expect(cleanBreaches([emailsOnly])).toHaveLength(1);
    expect(cleanBreaches([{ ...emailsOnly, PwnCount: 50000 }])).toHaveLength(0);
  });

  it("skips spam lists, fabricated, retired, malware, no domain and bad dates", () => {
    expect(
      cleanBreaches([
        { ...base, IsSpamList: true },
        { ...base, IsFabricated: true },
        { ...base, IsRetired: true },
        { ...base, IsMalware: true },
        { ...base, Domain: "" },
        { ...base, Domain: "not a domain" },
        { ...base, AddedDate: "yesterday" },
        { ...base, Name: "" },
        null,
      ])
    ).toEqual([]);
    expect(cleanBreaches("nope")).toEqual([]);
  });

  it("marks unverified breaches and tolerates a missing breach date", () => {
    const [b] = cleanBreaches([{ ...base, IsVerified: false, BreachDate: null }]);
    expect(b.isVerified).toBe(false);
    expect(b.breachDate).toBeNull();
  });
});

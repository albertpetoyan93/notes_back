import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../models/SignupSource", () => ({ default: { create: vi.fn() } }));
vi.mock("../configs/DB/sequelize", () => ({ default: { query: vi.fn() } }));

import SignupSource from "../models/SignupSource";
import sequelize from "../configs/DB/sequelize";
import SignupSourceService, { cleanSource, GROUP_BY } from "./SignupSourceService";

const create = vi.mocked(SignupSource.create);
const query = vi.mocked(sequelize.query);

beforeEach(() => vi.resetAllMocks());

describe("cleanSource", () => {
  it("keeps UTM tags trimmed and lower-cased", () => {
    expect(
      cleanSource({ source: " Instagram ", medium: "Bio", campaign: "Launch_Nov", content: "P03-Reel" }, false)
    ).toEqual({
      source: "instagram",
      medium: "bio",
      campaign: "launch_nov",
      content: "p03-reel",
      referrerDomain: null,
      landingPath: null,
    });
  });

  it("cuts long values and strips control characters", () => {
    const out = cleanSource({ source: "x".repeat(300), campaign: "a\u0000b\nc" }, false)!;
    expect(out.source!.length).toBe(100);
    expect(out.campaign).toBe("abc");
  });

  it("reduces a referrer to its domain and drops 2keevo's own", () => {
    expect(cleanSource({ referrer: "https://www.Google.com/search?q=x" }, false)!.referrerDomain).toBe("google.com");
    expect(cleanSource({ referrerDomain: "l.instagram.com" }, false)!.referrerDomain).toBe("l.instagram.com");
    expect(cleanSource({ referrer: "https://2keevo.com/pricing" }, false)).toBeNull();
    expect(cleanSource({ referrer: "https://app.2keevo.com/" }, false)).toBeNull();
    expect(cleanSource({ referrerDomain: "not a domain!" }, false)).toBeNull();
  });

  it("keeps only the path of the landing page", () => {
    expect(cleanSource({ landingPath: "/pricing?utm_source=x#top" }, false)!.landingPath).toBe("/pricing");
    expect(cleanSource({ landingPath: "https://evil.example/x" }, false)).toBeNull();
  });

  it("returns null for nothing useful, and ignores non-strings", () => {
    expect(cleanSource(undefined, false)).toBeNull();
    expect(cleanSource("instagram", false)).toBeNull();
    expect(cleanSource({ source: 42, medium: {} }, false)).toBeNull();
    expect(cleanSource({ source: "   " }, false)).toBeNull();
  });

  it("marks extension sign-ups, whatever the body says", () => {
    expect(cleanSource({ source: "facebook" }, true)).toEqual({
      source: "extension",
      medium: null,
      campaign: null,
      content: null,
      referrerDomain: null,
      landingPath: null,
    });
  });
});

describe("SignupSourceService.capture", () => {
  it("writes the cleaned source once for the user", async () => {
    await SignupSourceService.capture(7, { source: "Instagram" }, false);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, source: "instagram" }));
  });

  it("writes nothing for an untagged sign-up", async () => {
    await SignupSourceService.capture(7, {}, false);
    expect(create).not.toHaveBeenCalled();
  });

  it("never throws, so sign-up can't fail because of it", async () => {
    create.mockRejectedValue(new Error("db down"));
    await expect(SignupSourceService.capture(7, { source: "x" }, false)).resolves.toBeUndefined();
  });
});

describe("SignupSourceService.bySource", () => {
  it("groups by the chosen column with bound dates and names untagged rows", async () => {
    query.mockResolvedValue([
      { key: "instagram", signups: "12", activated: "7", paying: "2" },
      { key: null, signups: "3", activated: "1", paying: "0" },
    ] as never);
    const out = await SignupSourceService.bySource("2026-11-01", "2026-11-30", "source");
    const [sql, options] = query.mock.calls[0] as [string, any];
    expect(sql).toContain(`s."source"`);
    expect(options.replacements).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(out.rows).toEqual([
      { key: "instagram", signups: 12, activated: 7, paying: 2 },
      { key: null, signups: 3, activated: 1, paying: 0 },
    ]);
    expect(out.totals).toEqual({ signups: 15, activated: 8, paying: 2 });
    expect(out.untagged).toBe(3);
  });

  it("only allows known columns", () => {
    expect(GROUP_BY).toEqual(["source", "medium", "campaign", "content", "referrerDomain", "landingPath"]);
  });
});

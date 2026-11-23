import { describe, expect, it } from "vitest";
import {
  browserOf,
  cleanPageView,
  countryOf,
  deviceOf,
  isBot,
  mergeConversions,
  visitorHash,
} from "./TrafficService";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IG_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0";
const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const EDGE = `${CHROME_WIN} Edg/131.0.0.0`;
const ANDROID_TABLET = "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const ANDROID_PHONE =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";

const ctx = { day: "2026-11-25", salt: "s".repeat(64), ip: "203.0.113.7", userAgent: CHROME_WIN };

describe("user agent", () => {
  it("drops bots, link previews and empty agents", () => {
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(isBot("facebookexternalhit/1.1")).toBe(true);
    expect(isBot("Mozilla/5.0 HeadlessChrome/131.0")).toBe(true);
    expect(isBot("")).toBe(true);
    expect(isBot(CHROME_WIN)).toBe(false);
    expect(isBot(IG_APP)).toBe(false);
  });

  it("tells phones, tablets and desktops apart", () => {
    expect(deviceOf(IPHONE)).toBe("mobile");
    expect(deviceOf(ANDROID_PHONE)).toBe("mobile");
    expect(deviceOf(ANDROID_TABLET)).toBe("tablet");
    expect(deviceOf(CHROME_WIN)).toBe("desktop");
  });

  it("names the in-app browsers ads open in", () => {
    expect(browserOf(IG_APP)).toBe("Instagram app");
    expect(browserOf(`${IPHONE} [FBAN/FBIOS;FBAV/490.0]`)).toBe("Facebook app");
    expect(browserOf(EDGE)).toBe("Edge");
    expect(browserOf(CHROME_WIN)).toBe("Chrome");
    expect(browserOf(IPHONE)).toBe("Safari");
  });
});

describe("countryOf", () => {
  it("maps the browser time zone, never the IP", () => {
    expect(countryOf("America/New_York")).toBe("US");
    expect(countryOf("Europe/Paris")).toBe("FR");
    expect(countryOf("Not/AZone")).toBeNull();
    expect(countryOf(42)).toBeNull();
  });
});

describe("visitorHash", () => {
  it("is stable within a day and changes with the salt", () => {
    const a = visitorHash("salt-1", "203.0.113.7", CHROME_WIN);
    expect(a).toHaveLength(16);
    expect(visitorHash("salt-1", "203.0.113.7", CHROME_WIN)).toBe(a);
    expect(visitorHash("salt-2", "203.0.113.7", CHROME_WIN)).not.toBe(a);
    expect(a).not.toContain("203");
  });
});

describe("cleanPageView", () => {
  it("keeps the path, campaign tags, outside referrer and country", () => {
    const view = cleanPageView(
      {
        p: "/Pricing",
        q: "?utm_source=meta&utm_medium=paid&utm_campaign=ads-test-1&utm_content=a1-share&x=1",
        r: "https://l.instagram.com/?u=abc",
        tz: "America/Chicago",
      },
      ctx
    );
    expect(view).toEqual({
      day: "2026-11-25",
      visitor: visitorHash(ctx.salt, ctx.ip, ctx.userAgent),
      path: "/pricing",
      referrerDomain: "l.instagram.com",
      source: "meta",
      medium: "paid",
      campaign: "ads-test-1",
      content: "a1-share",
      country: "US",
      device: "desktop",
      browser: "Chrome",
    });
  });

  it("ignores our own domain as referrer and strips query and hash from the path", () => {
    const view = cleanPageView({ p: "/teams?x=1#top", r: "https://2keevo.com/" }, ctx);
    expect(view?.path).toBe("/teams");
    expect(view?.referrerDomain).toBeNull();
    expect(view?.campaign).toBeNull();
  });

  it("rejects bad input and bots", () => {
    expect(cleanPageView(null, ctx)).toBeNull();
    expect(cleanPageView([], ctx)).toBeNull();
    expect(cleanPageView({ p: "https://evil.example/" }, ctx)).toBeNull();
    expect(cleanPageView({ p: "//evil.example" }, ctx)).toBeNull();
    expect(cleanPageView({ p: "/" }, { ...ctx, userAgent: "curl/8.0" })).toBeNull();
  });
});

describe("mergeConversions", () => {
  it("joins visitors and sign-ups by key, busiest first", () => {
    expect(
      mergeConversions(
        [
          { key: "a1-share", visitors: 40 },
          { key: "a2-leak", visitors: 90 },
          { key: null, visitors: 500 },
        ],
        [
          { key: "a1-share", signups: 6 },
          { key: "bio", signups: 2 },
        ]
      )
    ).toEqual([
      { key: "a2-leak", visitors: 90, signups: 0 },
      { key: "a1-share", visitors: 40, signups: 6 },
      { key: "bio", visitors: 0, signups: 2 },
    ]);
  });
});

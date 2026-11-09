import { describe, expect, it } from "vitest";
import {
  brandLabel,
  matchesHost,
  nameMatchesHost,
  normalizeHost,
  rootHost,
} from "./hostMatch";

describe("hostMatch", () => {
  it("normalizes and takes the registrable root", () => {
    expect(normalizeHost("WWW.Go.Ssbacademy.Am.")).toBe("go.ssbacademy.am");
    expect(rootHost("go.ssbacademy.am")).toBe("ssbacademy.am");
    expect(brandLabel("go.ssbacademy.am")).toBe("ssbacademy");
    expect(brandLabel("shop.foo.co.uk")).toBe("foo");
  });

  it("does not match another site that only shares a TLD", () => {
    expect(nameMatchesHost("name.am", "go.ssbacademy.am")).toBe(false);
    expect(matchesHost(["name.am", "https://name.am"], "go.ssbacademy.am")).toBe(false);
    expect(matchesHost(["name.am", "https://name.am"], "name.am")).toBe(true);
  });

  it("does not match on a short standalone am token in the title", () => {
    expect(nameMatchesHost("Foo am Bar", "go.ssbacademy.am")).toBe(false);
    expect(nameMatchesHost("amazon", "go.ssbacademy.am")).toBe(false);
  });

  it("matches the site brand by name or URL", () => {
    expect(nameMatchesHost("SSB Academy", "go.ssbacademy.am")).toBe(true);
    expect(nameMatchesHost("ssbacademy", "go.ssbacademy.am")).toBe(true);
    expect(matchesHost(["Login", "https://go.ssbacademy.am/home"], "go.ssbacademy.am")).toBe(true);
    expect(nameMatchesHost("GitHub", "github.com")).toBe(true);
  });

  it("does not treat short subdomain labels as a name match", () => {
    expect(nameMatchesHost("Go somewhere", "go.ssbacademy.am")).toBe(false);
  });
});

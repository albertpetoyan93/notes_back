import { describe, expect, it } from "vitest";
import { parseExtensionVersion } from "./extensionVersion";

describe("parseExtensionVersion", () => {
  it("accepts short semver", () => {
    expect(parseExtensionVersion("1.2.3")).toBe("1.2.3");
    expect(parseExtensionVersion("0.1")).toBe("0.1");
  });

  it("rejects empty, long, or garbage", () => {
    expect(parseExtensionVersion(undefined)).toBeNull();
    expect(parseExtensionVersion("")).toBeNull();
    expect(parseExtensionVersion("  ")).toBeNull();
    expect(parseExtensionVersion("v1.2.3")).toBeNull();
    expect(parseExtensionVersion("1.2.3-beta")).toBeNull();
    expect(parseExtensionVersion("1".repeat(40))).toBeNull();
  });
});

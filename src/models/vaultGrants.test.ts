import { describe, expect, it } from "vitest";
import CollectionShare from "@src/models/CollectionShare";

describe("CollectionShare grant fields (ADR-002)", () => {
  it("a share isn't a vault manager by default, and comes from a direct share", () => {
    const attributes = CollectionShare.getAttributes() as Record<string, { defaultValue?: unknown }>;
    expect(attributes.manages?.defaultValue).toBe(false);
    expect(attributes.source?.defaultValue).toBe("direct");
  });
});

import { describe, expect, it } from "vitest";
import MetricsDaily from "@src/models/MetricsDaily";
import UserSession from "@src/models/UserSession";

describe("metrics daily model", () => {
  it("declares metrics_daily and extensionVersion", () => {
    expect(MetricsDaily.getTableName()).toBe("metrics_daily");
    expect(Object.keys(MetricsDaily.getAttributes())).toEqual(
      expect.arrayContaining([
        "date",
        "dau",
        "wau",
        "mau",
        "mrrCents",
        "mrrByPlan",
        "activatedFirstItem",
        "activatedExtension",
        "activatedAutofill",
      ])
    );
    expect(Object.keys(UserSession.getAttributes())).toEqual(
      expect.arrayContaining(["extensionVersion"])
    );
  });
});

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import sequelize from "../configs/DB/sequelize";
import StripeService from "./StripeService";

const fake = { subscriptions: { retrieve: vi.fn() } };
const query = vi.spyOn(sequelize, "query") as unknown as ReturnType<typeof vi.fn>;

const event = (id: string) =>
  ({ id, type: "customer.subscription.created", data: { object: { id: "sub_X" } } }) as unknown as Stripe.Event;

const remote = (lookupKey: string | null, metadata: Record<string, string> = {}) => ({
  id: "sub_X",
  status: "active",
  customer: "cus_X",
  metadata,
  items: { data: [{ quantity: 1, price: { id: "price_X", lookup_key: lookupKey, metadata: {} } }] },
});

afterAll(() => StripeService.setClient(null));

beforeEach(() => {
  vi.resetAllMocks();
  StripeService.setClient(fake as unknown as Stripe);
});

describe("webhooks for subscriptions that aren't 2keevo's", () => {
  it("acknowledges an event on a foreign price instead of failing, and marks it done", async () => {
    query.mockResolvedValueOnce([{ id: 1 }]).mockResolvedValue([]);
    fake.subscriptions.retrieve.mockResolvedValue(remote("some_other_product"));

    await expect(StripeService.handle(event("evt_foreign"))).resolves.toBe(true);

    const [sql, options] = query.mock.calls[1];
    expect(sql).toContain(`"processedAt" = NOW()`);
    expect(options.replacements.note).toMatch(/^ignored: /);
  });

  it("still fails (so Stripe retries) when a 2keevo price has no 2keevo owner", async () => {
    query.mockResolvedValueOnce([{ id: 2 }]).mockResolvedValue([]);
    fake.subscriptions.retrieve.mockResolvedValue(remote("premium_month"));

    await expect(StripeService.handle(event("evt_orphan"))).rejects.toThrow(/no 2keevo owner/);

    const last = query.mock.calls[query.mock.calls.length - 1];
    expect(last[0]).not.toContain("processedAt");
    expect(last[1].replacements.error).toMatch(/no 2keevo owner/);
  });
});

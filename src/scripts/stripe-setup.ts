/**
 * Sets up 2keevo's products, prices and customer portal in a Stripe account.
 * Safe to run again: it only adds what's missing (prices are found by lookup key).
 *
 *   npm run stripe:setup                      (uses STRIPE_SECRET_KEY from env/development.env)
 *   npm run stripe:setup -- --webhook-url=https://app.2keevo.com/api/billing/webhooks/stripe
 *
 * Use a test-mode key (sk_test_…) until you're ready for real payments.
 */
import Stripe from "stripe";
import { DISCOUNT_COUPON, lookupKey } from "../services/StripeService";
import { DISCOUNT_PERCENT, PRICES, type PlanId } from "../common/plans";

type Interval = "month" | "year";

// Amount in cents for each billing period (yearly = 12 months at the yearly rate).
const CATALOG: { plan: Exclude<PlanId, "free">; name: string; description: string; prices: Record<Interval, number> }[] = [
  {
    plan: "premium",
    name: "2keevo Premium",
    description: "Unlimited sharing and collections, share expiry, password health.",
    prices: { month: PRICES.premium.month, year: PRICES.premium.year * 12 },
  },
  {
    plan: "family",
    name: "2keevo Family",
    description: "Premium for up to 6 people, with a shared family collection.",
    prices: { month: PRICES.family.month, year: PRICES.family.year * 12 },
  },
  {
    plan: "team",
    name: "2keevo Team",
    description: "Company collections and roles, Premium for every member. Per member.",
    prices: { month: PRICES.team.month, year: PRICES.team.year * 12 },
  },
];

const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
];

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Set STRIPE_SECRET_KEY in the env file first.");
  const stripe = new Stripe(key);
  const live = key.startsWith("sk_live_");
  console.log(`Stripe account: ${live ? "LIVE (real money)" : "test mode"}\n`);

  // Products and prices
  const products = await stripe.products.list({ limit: 100, active: true });
  for (const item of CATALOG) {
    let product = products.data.find((p) => p.metadata?.app === "2keevo" && p.metadata?.plan === item.plan);
    if (!product) {
      product = await stripe.products.create({
        name: item.name,
        description: item.description,
        tax_code: "txcd_10103001", // Software as a service, business use
        metadata: { app: "2keevo", plan: item.plan },
      });
      console.log(`+ product ${item.name}`);
    }
    for (const interval of ["month", "year"] as Interval[]) {
      const lookup = lookupKey(item.plan, interval);
      const existing = await stripe.prices.list({ lookup_keys: [lookup], limit: 1 });
      if (existing.data[0]) {
        console.log(`= price ${lookup} (${existing.data[0].id})`);
        continue;
      }
      const price = await stripe.prices.create({
        product: product.id,
        currency: "usd",
        unit_amount: item.prices[interval],
        recurring: { interval },
        lookup_key: lookup,
        tax_behavior: "exclusive",
        metadata: { app: "2keevo", lookup_key: lookup },
      });
      console.log(`+ price ${lookup}: $${(item.prices[interval] / 100).toFixed(2)}/${interval} (${price.id})`);
    }
  }

  // Nonprofit and school discount: off Team only, for as long as the company stays on it.
  try {
    await stripe.coupons.retrieve(DISCOUNT_COUPON);
    console.log(`= coupon ${DISCOUNT_COUPON}`);
  } catch {
    const team = (await stripe.products.list({ limit: 100, active: true })).data.find(
      (p) => p.metadata?.app === "2keevo" && p.metadata?.plan === "team"
    );
    await stripe.coupons.create({
      id: DISCOUNT_COUPON,
      name: `Nonprofit and school (${DISCOUNT_PERCENT}% off Team)`,
      percent_off: DISCOUNT_PERCENT,
      duration: "forever",
      ...(team ? { applies_to: { products: [team.id] } } : {}),
      metadata: { app: "2keevo" },
    });
    console.log(`+ coupon ${DISCOUNT_COUPON}: ${DISCOUNT_PERCENT}% off Team`);
  }

  // Customer portal: card, invoices, billing details; cancelling ends the plan at period end.
  const appUrl = (process.env.FRONTEND_ORIGIN || "http://localhost:5173").split(",")[0].trim();
  const configs = await stripe.billingPortal.configurations.list({ limit: 100 });
  if (!configs.data.some((config) => config.metadata?.app === "2keevo")) {
    const config = await stripe.billingPortal.configurations.create({
      business_profile: { headline: "2keevo billing" },
      default_return_url: `${appUrl}/settings/billing`,
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        customer_update: { enabled: true, allowed_updates: ["email", "address", "name", "tax_id"] },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
      },
      metadata: { app: "2keevo" },
    });
    console.log(`+ customer portal (${config.id})`);
  } else {
    console.log("= customer portal");
  }

  // Webhook endpoint (production). Locally, use: stripe listen --forward-to localhost:9000/api/billing/webhooks/stripe
  const webhookArg = process.argv.find((arg) => arg.startsWith("--webhook-url="));
  if (webhookArg) {
    const url = webhookArg.split("=").slice(1).join("=");
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    if (endpoints.data.some((endpoint) => endpoint.url === url)) {
      console.log(`= webhook ${url} (its signing secret is in the Stripe dashboard)`);
    } else {
      const endpoint = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, metadata: { app: "2keevo" } });
      console.log(`+ webhook ${url}`);
      console.log(`\n  Put this in the server's env file (shown once):\n  STRIPE_WEBHOOK_SECRET=${endpoint.secret}\n`);
    }
  }

  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});

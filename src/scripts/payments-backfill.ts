/**
 * Copies payments made before the payment history existed into the `payments` table:
 * every paid invoice, then refunds. Safe to run again: rows are matched by invoice id.
 *
 *   npm run payments:backfill              (development, env/development.env)
 *   npm run payments:backfill:release      (server, compiled build)
 */
import sequelize from "../configs/DB/sequelize";
import PaymentService from "../services/PaymentService";
import StripeService from "../services/StripeService";

async function main() {
  const stripe = StripeService.client();
  let recorded = 0;
  let skipped = 0;

  for await (const invoice of stripe.invoices.list({ status: "paid", limit: 100 })) {
    try {
      (await PaymentService.recordInvoice(invoice.id!)) === "recorded" ? recorded++ : skipped++;
    } catch (error: any) {
      skipped++;
      console.warn(`! invoice ${invoice.id}: ${error?.message || error}`);
    }
  }
  console.log(`invoices: ${recorded} recorded, ${skipped} skipped (trial starts, other products)`);

  let refunds = 0;
  for await (const charge of stripe.charges.list({ limit: 100 })) {
    if (!charge.amount_refunded) continue;
    if ((await PaymentService.recordRefund(charge)) === "recorded") refunds++;
  }
  console.log(`refunds: ${refunds} recorded`);
}

main()
  .then(() => sequelize.close())
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });

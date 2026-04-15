import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * GDPR compliance webhook: customers/data_request
 *
 * Fired when a shop owner requests a customer's data on behalf of the customer.
 * We must return any personal data we store about that customer within 30 days.
 *
 * SuperCartD stores no customer-identifiable data:
 * - AnalyticsEvent: only product/variant IDs, cart totals, item counts (no customer ID)
 * - CartDrawerConfig, ShopPlan, ShopUsage, ProcessedOrder: shop-scoped only
 * - Session: merchant staff data (Shopify admin users), not storefront customers
 *
 * Therefore, the response is a 200 with no data. Shopify requires that we still
 * acknowledge the webhook (HMAC verified) to remain compliant.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const customerId =
    (payload as { customer?: { id?: number | string } }).customer?.id ?? "unknown";

  console.log(
    `[${topic}] Data request received for shop=${shop} customer=${customerId}. ` +
      `SuperCartD stores no customer PII — nothing to return.`,
  );

  return new Response(null, { status: 200 });
};

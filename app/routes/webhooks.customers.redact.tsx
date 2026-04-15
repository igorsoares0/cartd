import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * GDPR compliance webhook: customers/redact
 *
 * Fired 10 days after a shop owner requests redaction of a customer's data.
 * We must erase any personal data we store about that customer.
 *
 * SuperCartD stores no customer-identifiable data (see data_request webhook
 * for full reasoning), so there is nothing to erase. We still acknowledge the
 * webhook to remain compliant.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const customerId =
    (payload as { customer?: { id?: number | string } }).customer?.id ?? "unknown";

  console.log(
    `[${topic}] Redact request received for shop=${shop} customer=${customerId}. ` +
      `SuperCartD stores no customer PII — nothing to erase.`,
  );

  return new Response(null, { status: 200 });
};

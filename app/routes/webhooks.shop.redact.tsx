import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR compliance webhook: shop/redact
 *
 * Fired 48 hours after a shop uninstalls the app. All shop-scoped data must be
 * erased. app/uninstalled already clears this data, but shop/redact is the
 * mandatory backstop required by Shopify to guarantee erasure.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`[${topic}] Redact request received for shop=${shop}`);

  await Promise.all([
    db.session.deleteMany({ where: { shop } }),
    db.shopPlan.deleteMany({ where: { shop } }),
    db.shopUsage.deleteMany({ where: { shop } }),
    db.cartDrawerConfig.deleteMany({ where: { shop } }),
    db.analyticsEvent.deleteMany({ where: { shop } }),
    db.processedOrder.deleteMany({ where: { shop } }),
  ]);

  console.log(`[${topic}] All data erased for shop=${shop}`);

  return new Response(null, { status: 200 });
};

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    // Clean up all shop data so reinstalls start fresh
    await Promise.all([
      db.session.deleteMany({ where: { shop } }),
      db.shopPlan.deleteMany({ where: { shop } }),
      db.shopUsage.deleteMany({ where: { shop } }),
      db.cartDrawerConfig.deleteMany({ where: { shop } }),
      db.analyticsEvent.deleteMany({ where: { shop } }),
    ]);

    console.log(`[app/uninstalled] Cleaned up all data for ${shop}`);
  }

  return new Response();
};

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Handles app_subscriptions/update webhook.
 * Fired when a merchant's subscription status changes (activated, cancelled, declined, etc.)
 * This keeps our local ShopPlan in sync without relying on the merchant visiting the app.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { payload, shop, topic } = await authenticate.webhook(request);

    console.log(
      `[app_subscriptions/update] Received ${topic} for ${shop}:`,
      JSON.stringify(payload, null, 2),
    );

    const subscriptionPayload = payload as {
      app_subscription?: {
        admin_graphql_api_id?: string;
        status?: string;
        name?: string;
      };
    };

    const sub = subscriptionPayload.app_subscription;
    if (!sub) {
      console.warn("[app_subscriptions/update] No app_subscription in payload");
      return new Response(null, { status: 200 });
    }

    const status = sub.status?.toUpperCase();
    const subscriptionGid = sub.admin_graphql_api_id ?? null;

    if (status === "ACTIVE") {
      // Subscription is active — determine plan from the name
      // Name format: "SuperCartD Growth", "SuperCartD Pro", etc.
      const name = sub.name?.toLowerCase() ?? "";
      let plan = "starter";
      if (name.includes("pro")) {
        plan = "pro";
      } else if (name.includes("growth")) {
        plan = "growth";
      }

      await prisma.shopPlan.upsert({
        where: { shop },
        update: {
          plan,
          subscriptionGid,
          hasUsedTrial: true,
          isFrozen: false,
        },
        create: {
          shop,
          plan,
          subscriptionGid,
          hasUsedTrial: true,
          isFrozen: false,
        },
      });

      console.log(`[app_subscriptions/update] ${shop} → plan=${plan} (ACTIVE)`);
    } else if (status === "FROZEN") {
      // FROZEN is non-terminal — subscription reactivates when payments resume.
      // Keep the plan and subscriptionGid intact, just flag as frozen.
      await prisma.shopPlan.upsert({
        where: { shop },
        update: { isFrozen: true },
        create: { shop, plan: "starter", isFrozen: true },
      });

      console.log(
        `[app_subscriptions/update] ${shop} → FROZEN (plan kept, features disabled)`,
      );
    } else if (
      status === "CANCELLED" ||
      status === "DECLINED" ||
      status === "EXPIRED"
    ) {
      // Terminal states — revert to starter
      await prisma.shopPlan.upsert({
        where: { shop },
        update: {
          plan: "starter",
          subscriptionGid: null,
          isFrozen: false,
        },
        create: { shop, plan: "starter", subscriptionGid: null },
      });

      console.log(
        `[app_subscriptions/update] ${shop} → plan=starter (${status})`,
      );
    }

    return new Response(null, { status: 200 });
  } catch (err) {
    console.error("[app_subscriptions/update] Webhook error:", err);
    return new Response(null, { status: 500 });
  }
};

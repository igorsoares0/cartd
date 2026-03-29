import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { payload, shop, topic } = await authenticate.webhook(request);

    console.log(`[orders-create] Received ${topic} webhook for ${shop}`);

    // Extract order ID for idempotency — Shopify can deliver webhooks multiple times
    const orderPayload = payload as { id?: number; admin_graphql_api_id?: string };
    const orderId = String(
      orderPayload.admin_graphql_api_id ?? orderPayload.id ?? "",
    );

    if (!orderId) {
      console.warn("[orders-create] No order ID in payload, skipping");
      return new Response(null, { status: 200 });
    }

    // Dedup: try to insert into ProcessedOrder. If it already exists, skip.
    try {
      await prisma.processedOrder.create({
        data: { shop, orderId },
      });
    } catch (e: unknown) {
      // Unique constraint violation = already processed
      if (
        e instanceof Error &&
        "code" in e &&
        (e as { code: string }).code === "P2002"
      ) {
        console.log(
          `[orders-create] Duplicate webhook for order ${orderId}, skipping`,
        );
        return new Response(null, { status: 200 });
      }
      throw e; // Re-throw unexpected errors
    }

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    await prisma.shopUsage.upsert({
      where: { shop_month: { shop, month } },
      update: { orderCount: { increment: 1 } },
      create: { shop, month, orderCount: 1 },
    });

    console.log(`[orders-create] Order ${orderId} counted for ${shop} (${month})`);
    return new Response(null, { status: 200 });
  } catch (err) {
    console.error("[orders-create] Webhook error:", err);
    return new Response(null, { status: 500 });
  }
};

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { payload, shop, topic } = await authenticate.webhook(request);

    console.log(`[orders-create] Received ${topic} webhook for ${shop}`);

    const orderPayload = payload as {
      id?: number;
      admin_graphql_api_id?: string;
      line_items?: Array<{
        product_id?: number;
        variant_id?: number;
        price?: string;
        quantity?: number;
        total_discount?: string;
      }>;
    };

    // Extract order ID for idempotency — Shopify can deliver webhooks multiple times
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

    // --- Track upsell revenue from actual purchases ---
    // Load the shop's published config to get upsell variant IDs
    const configRecord = await prisma.cartDrawerConfig.findUnique({
      where: { shop },
      select: { config: true, published: true },
    });

    if (configRecord?.published && orderPayload.line_items?.length) {
      try {
        const config = JSON.parse(configRecord.config);
        const upsells: Array<{
          productId?: string;
          variantId?: string;
          enabled?: boolean;
        }> = config.body?.upsells ?? [];
        const enabledUpsells = upsells.filter((u) => u.enabled !== false);

        if (enabledUpsells.length > 0) {
          // Build a set of numeric variant IDs from the upsell config
          const upsellVariantIds = new Set<number>();
          for (const u of enabledUpsells) {
            if (u.variantId) {
              const numId = parseInt(
                u.variantId.replace("gid://shopify/ProductVariant/", ""),
                10,
              );
              if (!isNaN(numId)) upsellVariantIds.add(numId);
            }
          }

          // Match order line items against upsell variants
          for (const item of orderPayload.line_items) {
            if (item.variant_id && upsellVariantIds.has(item.variant_id)) {
              const gross =
                (parseFloat(item.price ?? "0") || 0) * (item.quantity ?? 1);
              const discount = parseFloat(item.total_discount ?? "0") || 0;
              const revenue = gross - discount;
              await prisma.analyticsEvent.create({
                data: {
                  shop,
                  event: "upsell_purchase",
                  metadata: JSON.stringify({
                    orderId,
                    variantId: item.variant_id,
                    productId: item.product_id,
                    revenue,
                    quantity: item.quantity ?? 1,
                  }),
                },
              });
              console.log(
                `[orders-create] Upsell purchase tracked: variant=${item.variant_id} revenue=${revenue}`,
              );
            }
          }
        }
      } catch (configErr) {
        console.error("[orders-create] Error matching upsell products:", configErr);
      }
    }

    console.log(`[orders-create] Order ${orderId} counted for ${shop} (${month})`);
    return new Response(null, { status: 200 });
  } catch (err) {
    console.error("[orders-create] Webhook error:", err);
    return new Response(null, { status: 500 });
  }
};

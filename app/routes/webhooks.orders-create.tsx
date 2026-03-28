import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { shop, topic } = await authenticate.webhook(request);

    console.log(`[orders-create] Received ${topic} webhook for ${shop}`);

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    await prisma.shopUsage.upsert({
      where: { shop_month: { shop, month } },
      update: { orderCount: { increment: 1 } },
      create: { shop, month, orderCount: 1 },
    });

    console.log(`[orders-create] Order counted for ${shop} (${month})`);
    return new Response(null, { status: 200 });
  } catch (err) {
    console.error("[orders-create] Webhook error:", err);
    return new Response(null, { status: 500 });
  }
};

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop } = await authenticate.webhook(request);

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  await prisma.shopUsage.upsert({
    where: { shop_month: { shop, month } },
    update: { orderCount: { increment: 1 } },
    create: { shop, month, orderCount: 1, plan: "starter" },
  });

  return new Response(null, { status: 200 });
};

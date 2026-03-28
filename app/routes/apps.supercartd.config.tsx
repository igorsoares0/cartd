import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { isShopOverLimitLocal } from "../utils/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);

  if (!session) {
    return new Response("null", {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const shop = session.shop;
  const record = await prisma.cartDrawerConfig.findUnique({ where: { shop } });

  if (!record || !record.published) {
    return new Response("null", {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30",
      },
    });
  }

  // If shop is over plan limit, return config with disabled flag
  // so the storefront JS degrades gracefully (e.g. hides upsells/rewards)
  // but NEVER blocks checkout
  const overLimit = await isShopOverLimitLocal(shop);

  if (overLimit) {
    const config = JSON.parse(record.config);
    config._overLimit = true;
    return new Response(JSON.stringify(config), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30",
      },
    });
  }

  return new Response(record.config, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
    },
  });
};

import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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

  return new Response(record.config, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
    },
  });
};

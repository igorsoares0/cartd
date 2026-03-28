import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { isShopOverLimitLocal } from "../utils/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);

  if (!session) {
    return new Response(
      JSON.stringify({ overLimit: false }),
      {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const overLimit = await isShopOverLimitLocal(session.shop);

  return new Response(
    JSON.stringify({ overLimit }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
      },
    },
  );
};

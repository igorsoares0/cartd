import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const VALID_EVENTS = [
  "drawer_open",
  "upsell_click",
  "upsell_add",
  "checkout_click",
] as const;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(shop: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(shop);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(shop, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { session } = await authenticate.public.appProxy(request);

    if (!session) {
      return new Response(
        JSON.stringify({ error: "App not installed" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }

    const shop = session.shop;

    if (!checkRateLimit(shop)) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded" }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    }

    const body = await request.json();
    const { event, metadata } = body as {
      event: string;
      metadata?: Record<string, unknown>;
    };

    if (!event || !VALID_EVENTS.includes(event as (typeof VALID_EVENTS)[number])) {
      return new Response(
        JSON.stringify({ error: "Invalid event type" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Strip any PII — only keep safe metadata keys
    const safeMetadata: Record<string, unknown> = {};
    if (metadata) {
      for (const key of ["productId", "variantId", "cartTotal", "itemCount", "value", "revenue"]) {
        if (key in metadata) {
          safeMetadata[key] = metadata[key];
        }
      }
    }

    await prisma.analyticsEvent.create({
      data: {
        shop,
        event,
        metadata: Object.keys(safeMetadata).length > 0
          ? JSON.stringify(safeMetadata)
          : null,
      },
    });

    return new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("Analytics event error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

import prisma from "../db.server";

export const PLANS = {
  starter: { name: "Starter", orders: 100, price: 9.99 },
  growth: { name: "Growth", orders: 500, price: 29.99 },
  pro: { name: "Pro", orders: -1, price: 79.99 }, // -1 = unlimited (JSON-safe)
} as const;

export type PlanKey = keyof typeof PLANS;

const PLAN_BY_PRICE: Record<string, PlanKey> = {
  "9.99": "starter",
  "29.99": "growth",
  "79.99": "pro",
};

export function isUnlimited(plan: PlanKey): boolean {
  return PLANS[plan].orders === -1;
}

export function getOrderLimit(plan: PlanKey): number | null {
  const limit = PLANS[plan].orders;
  return limit === -1 ? null : limit;
}

export function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

type ActiveSubscription = {
  id: string;
  name: string;
  status: string;
  lineItems: {
    plan: {
      pricingDetails: {
        price: { amount: string; currencyCode: string };
      };
    };
  }[];
};

/**
 * Query Shopify for the current app's active subscriptions.
 * Returns the first active subscription or null.
 */
export async function getActiveSubscription(
  admin: { graphql: Function },
): Promise<ActiveSubscription | null> {
  const response = await admin.graphql(
    `#graphql
    query ActiveSubscriptions {
      currentAppInstallation {
        activeSubscriptions {
          id
          name
          status
          lineItems {
            plan {
              pricingDetails {
                ... on AppRecurringPricing {
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }`,
  );

  const result = await response.json();
  const subs =
    result.data?.currentAppInstallation?.activeSubscriptions ?? [];

  // Return the first ACTIVE subscription (there should be at most one)
  return subs.length > 0 ? subs[0] : null;
}

/**
 * Determine the plan key from a Shopify subscription's price.
 */
export function planFromSubscription(
  sub: ActiveSubscription | null,
): PlanKey {
  if (!sub) return "starter";

  const price = sub.lineItems?.[0]?.plan?.pricingDetails?.price?.amount;
  if (!price) return "starter";

  return PLAN_BY_PRICE[parseFloat(price).toFixed(2)] ?? "starter";
}

/**
 * Sync the local ShopPlan record with Shopify's actual subscription state.
 * This is the single source of truth reconciliation.
 */
export async function syncShopPlan(
  admin: { graphql: Function },
  shop: string,
): Promise<{ plan: PlanKey; subscriptionGid: string | null }> {
  const activeSub = await getActiveSubscription(admin);
  const plan = planFromSubscription(activeSub);
  const subscriptionGid = activeSub?.id ?? null;

  await prisma.shopPlan.upsert({
    where: { shop },
    update: { plan, subscriptionGid },
    create: { shop, plan, subscriptionGid },
  });

  return { plan, subscriptionGid };
}

/**
 * Get the shop's current billing state: plan, usage, and limit status.
 * Verifies against Shopify's actual subscription.
 */
export async function getShopBilling(
  admin: { graphql: Function },
  shop: string,
) {
  const { plan, subscriptionGid } = await syncShopPlan(admin, shop);
  const month = getCurrentMonth();

  const usage = await prisma.shopUsage.findUnique({
    where: { shop_month: { shop, month } },
  });

  const orderCount = usage?.orderCount ?? 0;
  const orderLimit = getOrderLimit(plan);
  const isOverLimit = orderLimit !== null && orderCount >= orderLimit;

  return {
    plan,
    subscriptionGid,
    orderCount,
    orderLimit,
    month,
    isOverLimit,
  };
}

/**
 * Quick plan check without calling Shopify API.
 * Reads from local DB only — use when you've already synced recently
 * (e.g., from a webhook handler).
 */
export async function getShopPlanLocal(shop: string): Promise<PlanKey> {
  const record = await prisma.shopPlan.findUnique({ where: { shop } });
  return (record?.plan as PlanKey) ?? "starter";
}

/**
 * Cancel the active subscription for a shop.
 * Returns true if cancelled, false if no active subscription found.
 */
export async function cancelActiveSubscription(
  admin: { graphql: Function },
  shop: string,
): Promise<{ success: boolean; error?: string }> {
  const activeSub = await getActiveSubscription(admin);

  if (!activeSub) {
    return { success: false, error: "No active subscription to cancel" };
  }

  const response = await admin.graphql(
    `#graphql
    mutation AppSubscriptionCancel($id: ID!) {
      appSubscriptionCancel(id: $id) {
        appSubscription { id status }
        userErrors { field message }
      }
    }`,
    { variables: { id: activeSub.id } },
  );

  const result = await response.json();
  const userErrors = result.data?.appSubscriptionCancel?.userErrors ?? [];

  if (userErrors.length > 0) {
    return { success: false, error: userErrors[0].message };
  }

  // Update local DB to starter
  await prisma.shopPlan.upsert({
    where: { shop },
    update: { plan: "starter", subscriptionGid: null },
    create: { shop, plan: "starter", subscriptionGid: null },
  });

  return { success: true };
}

/**
 * Check if shop is over its plan limit using local DB only.
 * Used by storefront endpoints (app proxy) where we don't have admin API access.
 */
export async function isShopOverLimitLocal(shop: string): Promise<boolean> {
  const plan = await getShopPlanLocal(shop);
  const limit = getOrderLimit(plan);
  if (limit === null) return false; // unlimited

  const month = getCurrentMonth();
  const usage = await prisma.shopUsage.findUnique({
    where: { shop_month: { shop, month } },
  });

  return (usage?.orderCount ?? 0) >= limit;
}

export const TRIAL_DAYS = 7;

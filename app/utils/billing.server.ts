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
  createdAt: string;
  trialDays: number;
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
          createdAt
          trialDays
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
 * Calculate when the trial ends based on subscription createdAt + trialDays.
 * Returns null if there's no trial.
 */
function calcTrialEndsAt(sub: ActiveSubscription | null): Date | null {
  if (!sub || !sub.trialDays || sub.trialDays <= 0) return null;

  const created = new Date(sub.createdAt);
  const trialEnd = new Date(created);
  trialEnd.setDate(trialEnd.getDate() + sub.trialDays);
  return trialEnd;
}

/**
 * Check if a date is currently within a trial period.
 */
function isTrialActive(trialEndsAt: Date | null): boolean {
  if (!trialEndsAt) return false;
  return new Date() < trialEndsAt;
}

/**
 * Sync the local ShopPlan record with Shopify's actual subscription state.
 * This is the single source of truth reconciliation.
 */
export async function syncShopPlan(
  admin: { graphql: Function },
  shop: string,
): Promise<{
  plan: PlanKey;
  subscriptionGid: string | null;
  trialEndsAt: Date | null;
  onTrial: boolean;
}> {
  const activeSub = await getActiveSubscription(admin);
  const plan = planFromSubscription(activeSub);
  const subscriptionGid = activeSub?.id ?? null;
  const trialEndsAt = calcTrialEndsAt(activeSub);
  const onTrial = isTrialActive(trialEndsAt);

  await prisma.shopPlan.upsert({
    where: { shop },
    update: { plan, subscriptionGid, trialEndsAt },
    create: { shop, plan, subscriptionGid, trialEndsAt },
  });

  return { plan, subscriptionGid, trialEndsAt, onTrial };
}

/**
 * Get the shop's current billing state: plan, usage, and limit status.
 * Verifies against Shopify's actual subscription.
 * During an active trial, the shop is never considered over-limit.
 */
export async function getShopBilling(
  admin: { graphql: Function },
  shop: string,
) {
  const { plan, subscriptionGid, trialEndsAt, onTrial } =
    await syncShopPlan(admin, shop);
  const month = getCurrentMonth();

  const usage = await prisma.shopUsage.findUnique({
    where: { shop_month: { shop, month } },
  });

  const orderCount = usage?.orderCount ?? 0;
  const orderLimit = getOrderLimit(plan);
  // During trial, never enforce limits
  const isOverLimit =
    !onTrial && orderLimit !== null && orderCount >= orderLimit;

  return {
    plan,
    subscriptionGid,
    orderCount,
    orderLimit,
    month,
    isOverLimit,
    onTrial,
    trialEndsAt: trialEndsAt?.toISOString() ?? null,
  };
}

/**
 * Quick plan check without calling Shopify API.
 * Reads from local DB only — use when you've already synced recently
 * (e.g., from a webhook handler or storefront endpoint).
 */
export async function getShopPlanLocal(shop: string): Promise<PlanKey> {
  const record = await prisma.shopPlan.findUnique({ where: { shop } });
  return (record?.plan as PlanKey) ?? "starter";
}

/**
 * Check if shop is over its plan limit using local DB only.
 * Used by storefront endpoints (app proxy) where we don't have admin API access.
 * During an active trial, always returns false (not over limit).
 */
export async function isShopOverLimitLocal(shop: string): Promise<boolean> {
  const record = await prisma.shopPlan.findUnique({ where: { shop } });
  if (!record) return false;

  // During trial, never enforce limits
  if (record.trialEndsAt && new Date() < record.trialEndsAt) {
    return false;
  }

  const plan = (record.plan as PlanKey) ?? "starter";
  const limit = getOrderLimit(plan);
  if (limit === null) return false; // unlimited

  const month = getCurrentMonth();
  const usage = await prisma.shopUsage.findUnique({
    where: { shop_month: { shop, month } },
  });

  return (usage?.orderCount ?? 0) >= limit;
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

  // Update local DB to starter, clear trial
  await prisma.shopPlan.upsert({
    where: { shop },
    update: { plan: "starter", subscriptionGid: null, trialEndsAt: null },
    create: { shop, plan: "starter", subscriptionGid: null },
  });

  return { success: true };
}

export const TRIAL_DAYS = 7;

import { useCallback, useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import {
  PLANS,
  TRIAL_DAYS,
  getShopBilling,
  getActiveSubscription,
  cancelActiveSubscription,
  type PlanKey,
} from "../utils/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // syncShopPlan inside getShopBilling verifies the REAL subscription with Shopify
  const billing = await getShopBilling(admin, shop);

  // Check if returning from Shopify billing confirmation
  const url = new URL(request.url);
  const chargeId = url.searchParams.get("charge_id");
  let justConfirmed = false;

  if (chargeId) {
    // The merchant just returned from the Shopify billing screen.
    // getShopBilling already synced the plan from the active subscription,
    // so the plan is now correct in DB. We just flag it for the UI toast.
    justConfirmed =
      billing.plan !== "starter" || billing.subscriptionGid !== null;
  }

  return {
    currentPlan: billing.plan,
    hasActiveSubscription: billing.subscriptionGid !== null,
    orderCount: billing.orderCount,
    orderLimit: billing.orderLimit, // null = unlimited, number = limit
    month: billing.month,
    isOverLimit: billing.isOverLimit,
    onTrial: billing.onTrial,
    hasUsedTrial: billing.hasUsedTrial,
    trialEndsAt: billing.trialEndsAt,
    justConfirmed,
    trialDays: TRIAL_DAYS,
    plans: {
      starter: { name: "Starter", orders: 100, price: 9.99 },
      growth: { name: "Growth", orders: 500, price: 29.99 },
      pro: { name: "Pro", orders: null as number | null, price: 79.99 },
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // --- Cancel subscription ---
  if (intent === "cancel") {
    const result = await cancelActiveSubscription(admin, shop);
    if (result.success) {
      return { success: true, intent: "cancel" };
    }
    return { success: false, error: result.error ?? "Failed to cancel" };
  }

  // --- Create/change subscription ---
  const plan = formData.get("plan") as PlanKey;

  if (!PLANS[plan]) {
    return { success: false, error: "Invalid plan" };
  }

  // Guard: check if there's already an active subscription to prevent duplicates
  const existingSub = await getActiveSubscription(admin);
  if (existingSub) {
    // Shopify replaces the existing subscription when a new one is created,
    // but only after the merchant confirms. If the merchant spam-clicks,
    // multiple confirmationUrls could be generated. We allow it because
    // Shopify handles dedup on their side — only the last confirmed one wins.
    // However, if they're already on the requested plan, block the request.
    const existingPrice =
      existingSub.lineItems?.[0]?.plan?.pricingDetails?.price?.amount;
    const requestedPrice = PLANS[plan].price;
    if (
      existingPrice &&
      parseFloat(existingPrice).toFixed(2) === requestedPrice.toFixed(2)
    ) {
      return {
        success: false,
        error: "You're already on this plan",
      };
    }
  }

  const planData = PLANS[plan];
  const isTest = process.env.NODE_ENV !== "production";

  // Validate returnUrl — SHOPIFY_APP_URL must be a full absolute URL
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl || !appUrl.startsWith("https://")) {
    return {
      success: false,
      error:
        "App configuration error: SHOPIFY_APP_URL is missing or invalid. Contact support.",
    };
  }
  const returnUrl = `${appUrl}/app/billing`;

  // Only offer trial on the merchant's first-ever subscription
  const shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  const trialDays =
    shopPlan?.hasUsedTrial ? 0 : TRIAL_DAYS;

  const response = await admin.graphql(
    `#graphql
    mutation AppSubscriptionCreate(
      $name: String!
      $lineItems: [AppSubscriptionLineItemInput!]!
      $returnUrl: URL!
      $test: Boolean
      $trialDays: Int
    ) {
      appSubscriptionCreate(
        name: $name
        lineItems: $lineItems
        returnUrl: $returnUrl
        test: $test
        trialDays: $trialDays
      ) {
        appSubscription { id }
        confirmationUrl
        userErrors { field message }
      }
    }`,
    {
      variables: {
        name: `SuperCartD ${planData.name}`,
        returnUrl,
        test: isTest,
        trialDays,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: planData.price, currencyCode: "USD" },
                interval: "EVERY_30_DAYS",
              },
            },
          },
        ],
      },
    },
  );

  const result = await response.json();
  const data = result.data?.appSubscriptionCreate;
  const confirmationUrl = data?.confirmationUrl;
  const userErrors = data?.userErrors ?? [];

  if (userErrors.length > 0) {
    return { success: false, error: userErrors[0].message };
  }

  if (confirmationUrl) {
    // DO NOT update plan in DB here.
    // The plan will be synced from Shopify's actual subscription
    // when the merchant returns via returnUrl (loader runs syncShopPlan).
    return { success: true, intent: "subscribe", confirmationUrl };
  }

  return { success: false, error: "Failed to create subscription" };
};

export default function Billing() {
  const {
    currentPlan,
    hasActiveSubscription,
    orderCount,
    orderLimit,
    month,
    isOverLimit,
    onTrial,
    hasUsedTrial,
    trialEndsAt,
    justConfirmed,
    trialDays,
    plans,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const planData = plans[currentPlan as PlanKey];
  const usagePercent =
    orderLimit === null
      ? 0
      : Math.min((orderCount / orderLimit) * 100, 100);

  useEffect(() => {
    if (justConfirmed) {
      shopify.toast.show("Plan updated successfully!");
    }
  }, [justConfirmed, shopify]);

  useEffect(() => {
    if (fetcher.data && fetcher.state === "idle") {
      const data = fetcher.data as Record<string, unknown>;
      if (data.confirmationUrl) {
        open(data.confirmationUrl as string, "_top");
      } else if (data.intent === "cancel" && data.success) {
        shopify.toast.show("Subscription cancelled. You're now on the Starter plan.");
      } else if (data.error) {
        shopify.toast.show(data.error as string);
      }
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const handleSelectPlan = useCallback(
    (plan: string) => {
      fetcher.submit({ intent: "subscribe", plan }, { method: "POST" });
    },
    [fetcher],
  );

  const handleCancel = useCallback(() => {
    fetcher.submit({ intent: "cancel" }, { method: "POST" });
  }, [fetcher]);

  const isBusy = fetcher.state !== "idle";

  return (
    <s-page heading="Billing & Usage">
      {isOverLimit && (
        <s-banner heading="Plan limit reached" tone="warning" dismissible>
          You've used all {orderLimit} orders for this month. Upgrade your plan
          to continue using SuperCartD features.
        </s-banner>
      )}

      {onTrial && trialEndsAt && (
        <s-banner heading="Free trial active" tone="info" dismissible>
          Your {trialDays}-day free trial ends on{" "}
          {new Date(trialEndsAt).toLocaleDateString()}. All features are
          available with no order limits during the trial.
        </s-banner>
      )}

      <s-section heading="Current Usage">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-text type="strong">Plan:</s-text>
            <s-badge tone="info">
              {planData.name}{onTrial ? " (Trial)" : ""}
            </s-badge>
          </s-stack>

          <s-stack direction="inline" gap="base">
            <s-text type="strong">Period:</s-text>
            <s-text>{month}</s-text>
          </s-stack>

          <s-stack direction="inline" gap="base">
            <s-text type="strong">Orders:</s-text>
            <s-text>
              {orderCount} /{" "}
              {orderLimit === null ? "Unlimited" : orderLimit}
            </s-text>
          </s-stack>

          {orderLimit !== null && (
            <div
              style={{
                height: "8px",
                borderRadius: "4px",
                backgroundColor: "#E0E0E0",
                overflow: "hidden",
                width: "100%",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${usagePercent}%`,
                  backgroundColor: isOverLimit ? "#D82C0D" : "#2C6ECB",
                  borderRadius: "4px",
                  transition: "width 0.3s ease",
                }}
              />
            </div>
          )}

          {hasActiveSubscription && currentPlan !== "starter" && (
            <s-button
              variant="tertiary"
              tone="critical"
              onClick={handleCancel}
              {...(isBusy ? { loading: true } : {})}
            >
              Cancel subscription
            </s-button>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Plans">
        {!hasUsedTrial && (
          <s-text>
            All paid plans include a {trialDays}-day free trial.
          </s-text>
        )}

        <s-grid grid-template-columns="1fr 1fr 1fr" gap="base">
          {(
            Object.entries(plans) as [PlanKey, (typeof plans)[PlanKey]][]
          ).map(([key, plan]) => (
            <s-box
              key={key}
              padding="base"
              borderWidth="base"
              borderRadius="base"
              {...(key === currentPlan ? { background: "subdued" } : {})}
            >
              <s-stack direction="block" gap="base">
                <s-heading>{plan.name}</s-heading>
                <s-text type="strong">${plan.price}/mo</s-text>
                <s-text>
                  {plan.orders === null
                    ? "Unlimited orders"
                    : `Up to ${plan.orders} orders/month`}
                </s-text>
                {key === currentPlan ? (
                  <s-badge tone="success">Current Plan</s-badge>
                ) : (
                  <s-button
                    variant="primary"
                    onClick={() => handleSelectPlan(key)}
                    {...(isBusy ? { disabled: true } : {})}
                  >
                    {plan.price > plans[currentPlan as PlanKey].price
                      ? "Upgrade"
                      : "Downgrade"}
                  </s-button>
                )}
              </s-stack>
            </s-box>
          ))}
        </s-grid>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

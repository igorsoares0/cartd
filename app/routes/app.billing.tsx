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
    justConfirmed =
      billing.plan !== "starter" || billing.subscriptionGid !== null;
  }

  return {
    currentPlan: billing.plan,
    hasActiveSubscription: billing.subscriptionGid !== null,
    orderCount: billing.orderCount,
    orderLimit: billing.orderLimit,
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

  const existingSub = await getActiveSubscription(admin);
  if (existingSub) {
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

  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!appUrl || !appUrl.startsWith("https://")) {
    return {
      success: false,
      error:
        "App configuration error: SHOPIFY_APP_URL is missing or invalid. Contact support.",
    };
  }
  const returnUrl = `${appUrl}/app/billing`;

  const shopPlan = await prisma.shopPlan.findUnique({ where: { shop } });
  const trialDays = shopPlan?.hasUsedTrial ? 0 : TRIAL_DAYS;

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
    return { success: true, intent: "subscribe", confirmationUrl };
  }

  return { success: false, error: "Failed to create subscription" };
};

const PLAN_FEATURES: Record<string, string[]> = {
  starter: [
    "Up to 100 orders/month",
    "Cart drawer customization",
    "1 reward rule",
    "1 upsell offer",
  ],
  growth: [
    "Up to 500 orders/month",
    "All Starter features",
    "Up to 3 reward rules",
    "Up to 3 upsell offers",
    "Analytics dashboard",
  ],
  pro: [
    "Unlimited orders",
    "All Growth features",
    "Up to 5 reward rules",
    "Up to 5 upsell offers",
    "Priority support",
  ],
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
    if (fetcher.data && fetcher.state === "idle") {
      const data = fetcher.data as Record<string, unknown>;
      if (data.confirmationUrl) {
        open(data.confirmationUrl as string, "_top");
      } else if (data.intent === "cancel" && data.success) {
        shopify.toast.show(
          "Subscription cancelled. You're now on the Starter plan.",
        );
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
          You've used all {orderLimit} orders for this month. Upgrade your
          plan to continue using SuperCartD features.
        </s-banner>
      )}

      {onTrial && trialEndsAt && (
        <s-banner heading="Free trial active" tone="info" dismissible>
          Your {trialDays}-day free trial ends on{" "}
          {new Date(trialEndsAt).toLocaleDateString()}. All features are
          available with no order limits during the trial.
        </s-banner>
      )}

      {/* Current Usage — Metrics card pattern */}
      <s-section heading="Current Usage">
        <s-grid
          gridTemplateColumns="@container (inline-size <= 400px) 1fr, 1fr auto 1fr auto 1fr"
          gap="small"
        >
          <s-box paddingBlock="small-400" paddingInline="small-100">
            <s-grid gap="small-300">
              <s-heading>Plan</s-heading>
              <s-stack direction="inline" gap="small-200">
                <s-badge tone={isOverLimit ? "critical" : "success"}>
                  {planData.name}
                  {onTrial ? " (Trial)" : ""}
                </s-badge>
              </s-stack>
            </s-grid>
          </s-box>

          <s-divider direction="block" />

          <s-box paddingBlock="small-400" paddingInline="small-100">
            <s-grid gap="small-300">
              <s-heading>Orders This Month</s-heading>
              <s-text>
                {orderCount} /{" "}
                {orderLimit === null ? "Unlimited" : orderLimit}
              </s-text>
            </s-grid>
          </s-box>

          <s-divider direction="block" />

          <s-box paddingBlock="small-400" paddingInline="small-100">
            <s-grid gap="small-300">
              <s-heading>Period</s-heading>
              <s-text>{month}</s-text>
            </s-grid>
          </s-box>
        </s-grid>

        {/* Usage progress bar */}
        {orderLimit !== null && (
          <s-box paddingBlockStart="base">
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="base" align-items="center">
                <s-icon
                  type={isOverLimit ? "alert-circle" : "check-circle"}
                  tone={isOverLimit ? "critical" : "success"}
                />
                <s-text>
                  {isOverLimit
                    ? "You've exceeded your plan limit"
                    : `${Math.round(usagePercent)}% of plan limit used`}
                </s-text>
              </s-stack>
              <div
                style={{
                  height: "8px",
                  borderRadius: "var(--p-border-radius-100, 4px)",
                  backgroundColor:
                    "var(--p-color-bg-surface-secondary, #E0E0E0)",
                  overflow: "hidden",
                  width: "100%",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${usagePercent}%`,
                    backgroundColor: isOverLimit
                      ? "var(--p-color-bg-fill-critical, #D82C0D)"
                      : "var(--p-color-bg-fill-success, #008060)",
                    borderRadius: "var(--p-border-radius-100, 4px)",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </s-stack>
          </s-box>
        )}

        {hasActiveSubscription && currentPlan !== "starter" && (
          <s-box paddingBlockStart="base">
            <s-button
              variant="tertiary"
              tone="critical"
              onClick={handleCancel}
              {...(isBusy ? { loading: true } : {})}
            >
              Cancel subscription
            </s-button>
          </s-box>
        )}
      </s-section>

      {/* Plans */}
      <s-section heading="Choose Your Plan">
        {!hasUsedTrial && (
          <s-banner tone="info" dismissible>
            All paid plans include a {trialDays}-day free trial. No charge
            until the trial ends.
          </s-banner>
        )}

        <s-grid
          gridTemplateColumns="@container (inline-size <= 600px) 1fr, 1fr 1fr 1fr"
          gap="base"
        >
          {(
            Object.entries(plans) as [PlanKey, (typeof plans)[PlanKey]][]
          ).map(([key, plan]) => {
            const isCurrent = key === currentPlan;
            const isUpgrade = plan.price > plans[currentPlan as PlanKey].price;
            const features = PLAN_FEATURES[key] || [];

            return (
              <s-box
                key={key}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                {...(isCurrent ? { background: "subdued" } : {})}
              >
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="small-200" align-items="center">
                    <s-heading>{plan.name}</s-heading>
                    {isCurrent && (
                      <s-badge tone="success" icon="check-circle">
                        Current
                      </s-badge>
                    )}
                    {key === "growth" && !isCurrent && (
                      <s-badge tone="info">Popular</s-badge>
                    )}
                  </s-stack>

                  <s-stack direction="block" gap="small-200">
                    <s-text type="strong">
                      ${plan.price}
                      <s-text color="subdued">/month</s-text>
                    </s-text>
                    <s-text color="subdued">
                      {plan.orders === null
                        ? "Unlimited orders"
                        : `Up to ${plan.orders} orders/month`}
                    </s-text>
                  </s-stack>

                  <s-divider />

                  <s-stack direction="block" gap="small-200">
                    {features.map((feature, i) => (
                      <s-stack
                        key={i}
                        direction="inline"
                        gap="small-200"
                        align-items="center"
                      >
                        <s-icon type="check" tone="success" />
                        <s-text>{feature}</s-text>
                      </s-stack>
                    ))}
                  </s-stack>

                  {isCurrent ? (
                    <s-button variant="secondary" disabled>
                      Current Plan
                    </s-button>
                  ) : (
                    <s-button
                      variant="primary"
                      {...(key === "growth" && !isCurrent
                        ? { tone: "auto" }
                        : {})}
                      onClick={() => handleSelectPlan(key)}
                      {...(isBusy ? { disabled: true } : {})}
                    >
                      {isUpgrade ? "Upgrade" : "Downgrade"}
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            );
          })}
        </s-grid>
      </s-section>

      {/* Footer help */}
      <s-stack alignItems="center">
        <s-text>
          Learn more about{" "}
          <s-link href="https://supercartd.com/pricing" target="_blank">
            pricing and plans
          </s-link>
          .
        </s-text>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

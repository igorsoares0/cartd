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

const PLANS = {
  starter: { name: "Starter", orders: 100, price: 9.99 },
  growth: { name: "Growth", orders: 500, price: 29.99 },
  pro: { name: "Pro", orders: Infinity, price: 79.99 },
} as const;

type PlanKey = keyof typeof PLANS;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  let usage = await prisma.shopUsage.findUnique({
    where: { shop_month: { shop, month } },
  });

  if (!usage) {
    usage = await prisma.shopUsage.create({
      data: { shop, month, orderCount: 0, plan: "starter" },
    });
  }

  return {
    currentPlan: usage.plan as PlanKey,
    orderCount: usage.orderCount,
    month: usage.month,
    plans: PLANS,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const plan = formData.get("plan") as PlanKey;

  if (!PLANS[plan]) {
    return { success: false, error: "Invalid plan" };
  }

  const planData = PLANS[plan];

  // Create Shopify recurring charge
  const response = await admin.graphql(
    `#graphql
    mutation AppSubscriptionCreate($name: String!, $lineItems: [AppSubscriptionLineItemInput!]!, $returnUrl: URL!) {
      appSubscriptionCreate(
        name: $name
        lineItems: $lineItems
        returnUrl: $returnUrl
        test: true
      ) {
        appSubscription { id }
        confirmationUrl
        userErrors { field message }
      }
    }`,
    {
      variables: {
        name: `SuperCartD ${planData.name}`,
        returnUrl: `https://${shop}/admin/apps/cartd/app/billing`,
        lineItems: [
          {
            plan: {
              appRecurringPricingDetails: {
                price: { amount: planData.price, currencyCode: "USD" },
              },
            },
          },
        ],
      },
    },
  );

  const result = await response.json();
  const confirmationUrl =
    result.data?.appSubscriptionCreate?.confirmationUrl;

  if (confirmationUrl) {
    // Update plan in DB
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    await prisma.shopUsage.upsert({
      where: { shop_month: { shop, month } },
      update: { plan },
      create: { shop, month, orderCount: 0, plan },
    });

    return { success: true, confirmationUrl };
  }

  return {
    success: false,
    error:
      result.data?.appSubscriptionCreate?.userErrors?.[0]?.message ??
      "Failed to create subscription",
  };
};

export default function Billing() {
  const { currentPlan, orderCount, month, plans } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const planData = plans[currentPlan as PlanKey];
  const orderLimit = planData.orders;
  const usagePercent =
    orderLimit === Infinity
      ? 0
      : Math.min((orderCount / orderLimit) * 100, 100);
  const isOverLimit = orderLimit !== Infinity && orderCount >= orderLimit;

  useEffect(() => {
    if (fetcher.data && fetcher.state === "idle") {
      const data = fetcher.data as Record<string, unknown>;
      if (data.confirmationUrl) {
        // Redirect to Shopify billing confirmation
        open(data.confirmationUrl as string, "_top");
      } else if (data.error) {
        shopify.toast.show(data.error as string);
      }
    }
  }, [fetcher.data, fetcher.state, shopify]);

  const handleSelectPlan = useCallback(
    (plan: string) => {
      fetcher.submit({ plan }, { method: "POST" });
    },
    [fetcher],
  );

  const isBusy = fetcher.state !== "idle";

  return (
    <s-page heading="Billing & Usage">
      {isOverLimit && (
        <s-banner heading="Plan limit reached" tone="warning" dismissible>
          You've used all {orderLimit} orders for this month. Upgrade your plan
          to continue using SuperCartD features.
        </s-banner>
      )}

      <s-section heading="Current Usage">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-text type="strong">Plan:</s-text>
            <s-badge tone="info">{planData.name}</s-badge>
          </s-stack>

          <s-stack direction="inline" gap="base">
            <s-text type="strong">Period:</s-text>
            <s-text>{month}</s-text>
          </s-stack>

          <s-stack direction="inline" gap="base">
            <s-text type="strong">Orders:</s-text>
            <s-text>
              {orderCount} /{" "}
              {orderLimit === Infinity ? "Unlimited" : orderLimit}
            </s-text>
          </s-stack>

          {orderLimit !== Infinity && (
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
        </s-stack>
      </s-section>

      <s-section heading="Plans">
        <s-grid grid-template-columns="1fr 1fr 1fr" gap="base">
          {(Object.entries(plans) as [PlanKey, (typeof plans)[PlanKey]][]).map(
            ([key, plan]) => (
              <s-box
                key={key}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                {...(key === currentPlan ? { background: "subdued" } : {})}
              >
                <s-stack direction="block" gap="base">
                  <s-heading>{plan.name}</s-heading>
                  <s-text type="strong">
                    ${plan.price}/mo
                  </s-text>
                  <s-text>
                    {plan.orders === Infinity
                      ? "Unlimited orders"
                      : `Up to ${plan.orders} orders/month`}
                  </s-text>
                  {key === currentPlan ? (
                    <s-badge tone="success">Current Plan</s-badge>
                  ) : (
                    <s-button
                      variant="primary"
                      onClick={() => handleSelectPlan(key)}
                      {...(isBusy ? { loading: true } : {})}
                    >
                      {(PLANS[key].price > PLANS[currentPlan as PlanKey].price) ? "Upgrade" : "Switch"}
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            ),
          )}
        </s-grid>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

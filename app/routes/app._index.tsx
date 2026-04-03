import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { getShopBilling } from "../utils/billing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const billing = await getShopBilling(admin, shop);

  // Get config status
  const config = await prisma.cartDrawerConfig.findUnique({
    where: { shop },
    select: { published: true, config: true },
  });

  const hasConfig = !!config;
  const isPublished = config?.published ?? false;

  // Check if config has upsells and rewards configured
  let hasRewards = false;
  let hasUpsells = false;
  let drawerEnabled = false;
  if (config?.config) {
    try {
      const parsed = JSON.parse(config.config);
      hasRewards = (parsed.body?.rewards ?? []).some(
        (r: { enabled: boolean }) => r.enabled,
      );
      hasUpsells = (parsed.body?.upsells ?? []).some(
        (u: { enabled: boolean }) => u.enabled,
      );
      drawerEnabled = parsed.enabled !== false;
    } catch {}
  }

  // Get analytics summary (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const events = await prisma.analyticsEvent.findMany({
    where: { shop, createdAt: { gte: thirtyDaysAgo } },
    select: { event: true, metadata: true },
  });

  let drawerOpens = 0;
  let upsellAdds = 0;
  let checkoutClicks = 0;
  let upsellRevenue = 0;

  for (const e of events) {
    switch (e.event) {
      case "drawer_open":
        drawerOpens++;
        break;
      case "upsell_add":
        upsellAdds++;
        if (e.metadata) {
          try {
            const m = JSON.parse(e.metadata);
            const rev = m.revenue != null ? m.revenue : m.value;
            if (rev != null) upsellRevenue += Number(rev) || 0;
          } catch {}
        }
        break;
      case "checkout_click":
        checkoutClicks++;
        break;
    }
  }

  const checkoutRate =
    drawerOpens > 0 ? ((checkoutClicks / drawerOpens) * 100).toFixed(1) : "0.0";

  return {
    billing: {
      plan: billing.plan,
      orderCount: billing.orderCount,
      orderLimit: billing.orderLimit,
      isOverLimit: billing.isOverLimit,
      onTrial: billing.onTrial,
    },
    setup: {
      hasConfig,
      isPublished,
      hasRewards,
      hasUpsells,
      drawerEnabled,
    },
    metrics: {
      drawerOpens,
      upsellAdds,
      checkoutClicks,
      upsellRevenue: upsellRevenue.toFixed(2),
      checkoutRate,
    },
  };
};

export default function Index() {
  const { billing, setup, metrics } = useLoaderData<typeof loader>();

  // Setup guide state
  const completedSteps = [
    setup.drawerEnabled,
    setup.hasRewards || setup.hasUpsells,
    setup.isPublished,
  ].filter(Boolean).length;
  const totalSteps = 3;
  const allComplete = completedSteps === totalSteps;

  const [guideExpanded, setGuideExpanded] = useState(!allComplete);
  const [guideDismissed, setGuideDismissed] = useState(false);

  return (
    <s-page heading="SuperCartD">
      <s-button slot="primary-action" href="/app/editor" variant="primary">
        Open Editor
      </s-button>
      <s-button slot="secondary-actions" href="/app/analytics">
        View Analytics
      </s-button>

      {/* Plan limit warning */}
      {billing.isOverLimit && (
        <s-banner heading="Plan limit reached" tone="warning" dismissible>
          You've used all {billing.orderLimit} orders this month.{" "}
          <s-link href="/app/billing">Upgrade your plan</s-link> to continue
          using SuperCartD features.
        </s-banner>
      )}

      {/* Setup Guide — only show if not all complete and not dismissed */}
      {!allComplete && !guideDismissed && (
        <s-section>
          <s-grid gap="base">
            <s-grid gap="small-200">
              <s-grid
                gridTemplateColumns="1fr auto auto"
                gap="small-300"
                alignItems="center"
              >
                <s-heading>Setup Guide</s-heading>
                <s-button
                  accessibilityLabel="Dismiss Guide"
                  variant="tertiary"
                  tone="neutral"
                  icon="x"
                  onClick={() => setGuideDismissed(true)}
                />
                <s-button
                  accessibilityLabel="Toggle setup guide"
                  variant="tertiary"
                  tone="neutral"
                  icon={guideExpanded ? "chevron-up" : "chevron-down"}
                  onClick={() => setGuideExpanded(!guideExpanded)}
                />
              </s-grid>
              <s-paragraph>
                Complete these steps to start boosting your average order value.
              </s-paragraph>
              <s-paragraph color="subdued">
                {completedSteps} of {totalSteps} steps completed
              </s-paragraph>
            </s-grid>

            <s-box
              borderRadius="base"
              border="base"
              background="base"
              display={guideExpanded ? "auto" : "none"}
            >
              {/* Step 1: Enable Cart Drawer */}
              <s-box>
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  padding="small"
                >
                  <s-checkbox
                    label="Enable and customize your cart drawer"
                    checked={setup.drawerEnabled || undefined}
                    disabled
                  />
                  <s-button
                    accessibilityLabel="Toggle step 1"
                    variant="tertiary"
                    tone="neutral"
                    icon="chevron-down"
                  />
                </s-grid>
                {!setup.drawerEnabled && (
                  <s-box padding="base">
                    <s-grid gap="small-200">
                      <s-paragraph>
                        Open the editor to customize your cart drawer's header,
                        colors, and layout. Make it match your brand.
                      </s-paragraph>
                      <s-stack direction="inline" gap="small-200">
                        <s-button href="/app/editor">Open Editor</s-button>
                      </s-stack>
                    </s-grid>
                  </s-box>
                )}
              </s-box>

              <s-divider />

              {/* Step 2: Add rewards or upsells */}
              <s-box>
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  padding="small"
                >
                  <s-checkbox
                    label="Add rewards or upsell offers"
                    checked={
                      setup.hasRewards || setup.hasUpsells || undefined
                    }
                    disabled
                  />
                  <s-button
                    accessibilityLabel="Toggle step 2"
                    variant="tertiary"
                    tone="neutral"
                    icon="chevron-down"
                  />
                </s-grid>
                {!setup.hasRewards && !setup.hasUpsells && (
                  <s-box padding="base">
                    <s-grid gap="small-200">
                      <s-paragraph>
                        Set up free shipping thresholds or product upsells to
                        increase your average order value.
                      </s-paragraph>
                      <s-stack direction="inline" gap="small-200">
                        <s-button href="/app/editor">
                          Configure Offers
                        </s-button>
                      </s-stack>
                    </s-grid>
                  </s-box>
                )}
              </s-box>

              <s-divider />

              {/* Step 3: Publish */}
              <s-box>
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  padding="small"
                >
                  <s-checkbox
                    label="Publish your cart drawer to your store"
                    checked={setup.isPublished || undefined}
                    disabled
                  />
                  <s-button
                    accessibilityLabel="Toggle step 3"
                    variant="tertiary"
                    tone="neutral"
                    icon="chevron-down"
                  />
                </s-grid>
                {!setup.isPublished && (
                  <s-box padding="base">
                    <s-grid gap="small-200">
                      <s-paragraph>
                        When you're happy with your cart drawer, publish it to
                        make it live on your storefront.
                      </s-paragraph>
                      <s-stack direction="inline" gap="small-200">
                        <s-button href="/app/editor">
                          Go to Editor
                        </s-button>
                      </s-stack>
                    </s-grid>
                  </s-box>
                )}
              </s-box>
            </s-box>
          </s-grid>
        </s-section>
      )}

      {/* Metrics Cards — last 30 days */}
      <s-section padding="base">
        <s-grid gap="small-200">
          <s-stack
            direction="inline"
            gap="small-200"
            align-items="center"
          >
            <s-heading>Performance</s-heading>
            <s-badge tone="info">Last 30 days</s-badge>
          </s-stack>
        </s-grid>
        <s-grid
          gridTemplateColumns="@container (inline-size <= 400px) 1fr, 1fr auto 1fr auto 1fr"
          gap="small"
        >
          <s-clickable
            href="/app/analytics"
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Drawer Opens</s-heading>
              <s-stack direction="inline" gap="small-200">
                <s-text>{metrics.drawerOpens.toLocaleString()}</s-text>
              </s-stack>
            </s-grid>
          </s-clickable>

          <s-divider direction="block" />

          <s-clickable
            href="/app/analytics"
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Checkout Rate</s-heading>
              <s-stack direction="inline" gap="small-200">
                <s-text>{metrics.checkoutRate}%</s-text>
              </s-stack>
            </s-grid>
          </s-clickable>

          <s-divider direction="block" />

          <s-clickable
            href="/app/analytics"
            paddingBlock="small-400"
            paddingInline="small-100"
            borderRadius="base"
          >
            <s-grid gap="small-300">
              <s-heading>Upsell Revenue</s-heading>
              <s-stack direction="inline" gap="small-200">
                <s-text>${metrics.upsellRevenue}</s-text>
              </s-stack>
            </s-grid>
          </s-clickable>
        </s-grid>
      </s-section>

      {/* Status overview */}
      <s-section heading="Status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" align-items="center">
            <s-icon
              type={setup.drawerEnabled ? "check-circle" : "alert-circle"}
              tone={setup.drawerEnabled ? "success" : "warning"}
            />
            <s-text>Cart Drawer</s-text>
            <s-badge tone={setup.drawerEnabled ? "success" : "warning"}>
              {setup.drawerEnabled ? "Enabled" : "Disabled"}
            </s-badge>
          </s-stack>

          <s-stack direction="inline" gap="base" align-items="center">
            <s-icon
              type={setup.isPublished ? "check-circle" : "alert-circle"}
              tone={setup.isPublished ? "success" : "warning"}
            />
            <s-text>Configuration</s-text>
            <s-badge tone={setup.isPublished ? "success" : "caution"}>
              {setup.isPublished ? "Published" : "Draft"}
            </s-badge>
          </s-stack>

          <s-stack direction="inline" gap="base" align-items="center">
            <s-icon type="order" tone="info" />
            <s-text>Plan</s-text>
            <s-badge tone={billing.isOverLimit ? "critical" : "info"}>
              {billing.plan.charAt(0).toUpperCase() + billing.plan.slice(1)}
              {billing.onTrial ? " (Trial)" : ""}
            </s-badge>
            <s-text color="subdued">
              {billing.orderCount} /{" "}
              {billing.orderLimit === null
                ? "Unlimited"
                : billing.orderLimit}{" "}
              orders
            </s-text>
          </s-stack>
        </s-stack>
      </s-section>

      {/* Footer help */}
      <s-stack alignItems="center">
        <s-text>
          Need help?{" "}
          <s-link href="https://supercartd.com/docs" target="_blank">
            Read the documentation
          </s-link>{" "}
          or{" "}
          <s-link href="mailto:support@supercartd.com">
            contact support
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

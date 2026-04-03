import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

type TimeRange = "24h" | "7d" | "30d" | "all";

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const range = (url.searchParams.get("range") || "30d") as TimeRange;

  const sinceMap: Record<TimeRange, Date | null> = {
    "24h": daysAgo(1),
    "7d": daysAgo(7),
    "30d": daysAgo(30),
    all: null,
  };
  const since = sinceMap[range];

  const events = await prisma.analyticsEvent.findMany({
    where: {
      shop,
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    select: {
      event: true,
      metadata: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // Aggregate metrics
  let drawerOpens = 0;
  let upsellClicks = 0;
  let upsellAdds = 0;
  let checkoutClicks = 0;
  let upsellRevenue = 0;

  // Daily breakdown for chart
  const dailyMap = new Map<
    string,
    {
      opens: number;
      clicks: number;
      adds: number;
      checkouts: number;
      revenue: number;
    }
  >();

  for (const e of events) {
    const day = e.createdAt.toISOString().slice(0, 10);
    if (!dailyMap.has(day)) {
      dailyMap.set(day, {
        opens: 0,
        clicks: 0,
        adds: 0,
        checkouts: 0,
        revenue: 0,
      });
    }
    const d = dailyMap.get(day)!;

    switch (e.event) {
      case "drawer_open":
        drawerOpens++;
        d.opens++;
        break;
      case "upsell_click":
        upsellClicks++;
        d.clicks++;
        break;
      case "upsell_add":
        upsellAdds++;
        d.adds++;
        if (e.metadata) {
          try {
            const m = JSON.parse(e.metadata);
            const rev = m.revenue != null ? m.revenue : m.value;
            if (rev != null) {
              const amount = Number(rev) || 0;
              upsellRevenue += amount;
              d.revenue += amount;
            }
          } catch {}
        }
        break;
      case "checkout_click":
        checkoutClicks++;
        d.checkouts++;
        break;
    }
  }

  // Build daily data array
  const days =
    range === "24h" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const chartDays = range === "all" ? Math.max(dailyMap.size, 30) : days;

  const dailyData: Array<{
    date: string;
    opens: number;
    clicks: number;
    adds: number;
    checkouts: number;
    revenue: number;
  }> = [];

  for (let i = chartDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = d.toISOString().slice(0, 10);
    const entry = dailyMap.get(day) || {
      opens: 0,
      clicks: 0,
      adds: 0,
      checkouts: 0,
      revenue: 0,
    };
    dailyData.push({ date: day, ...entry });
  }

  const upsellCTR =
    drawerOpens > 0
      ? ((upsellClicks / drawerOpens) * 100).toFixed(1)
      : "0.0";
  const upsellAddRate =
    upsellClicks > 0
      ? ((upsellAdds / upsellClicks) * 100).toFixed(1)
      : "0.0";
  const checkoutRate =
    drawerOpens > 0
      ? ((checkoutClicks / drawerOpens) * 100).toFixed(1)
      : "0.0";

  const rangeLabel =
    range === "24h"
      ? "24 hours"
      : range === "7d"
        ? "7 days"
        : range === "30d"
          ? "30 days"
          : "All time";

  return {
    range,
    rangeLabel,
    metrics: {
      drawerOpens,
      upsellClicks,
      upsellAdds,
      checkoutClicks,
      upsellCTR,
      upsellAddRate,
      checkoutRate,
      upsellRevenue: upsellRevenue.toFixed(2),
    },
    dailyData,
  };
};

export default function AnalyticsPage() {
  const { range, rangeLabel, metrics, dailyData } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const maxOpens = Math.max(...dailyData.map((d) => d.opens), 1);
  const ranges: { key: TimeRange; label: string }[] = [
    { key: "24h", label: "24h" },
    { key: "7d", label: "7d" },
    { key: "30d", label: "30d" },
    { key: "all", label: "All" },
  ];

  return (
    <s-page heading="Analytics">
      <s-stack direction="block" gap="large">
        {/* Time range selector */}
        <s-section>
          <s-stack direction="inline" gap="base" align-items="center">
            <s-icon type="clock" tone="info" />
            <s-text type="strong">Time Range</s-text>
            <s-button-group gap="base">
              {ranges.map((r) => (
                <s-button
                  key={r.key}
                  variant={range === r.key ? "primary" : "tertiary"}
                  onClick={() => setSearchParams({ range: r.key })}
                >
                  {r.label}
                </s-button>
              ))}
            </s-button-group>
          </s-stack>
        </s-section>

        {/* KPI Metrics — using Polaris metrics card pattern */}
        <s-section padding="base">
          <s-grid
            gridTemplateColumns="@container (inline-size <= 500px) 1fr 1fr, 1fr auto 1fr auto 1fr auto 1fr"
            gap="small"
          >
            <s-box paddingBlock="small-400" paddingInline="small-100">
              <s-grid gap="small-300">
                <s-stack direction="inline" gap="small-200" align-items="center">
                  <s-icon type="money" tone="success" />
                  <s-heading>Upsell Revenue</s-heading>
                </s-stack>
                <s-text type="strong">${metrics.upsellRevenue}</s-text>
                <s-text color="subdued">{rangeLabel}</s-text>
              </s-grid>
            </s-box>

            <s-divider direction="block" />

            <s-box paddingBlock="small-400" paddingInline="small-100">
              <s-grid gap="small-300">
                <s-stack direction="inline" gap="small-200" align-items="center">
                  <s-icon type="cart" tone="info" />
                  <s-heading>Checkout Rate</s-heading>
                </s-stack>
                <s-stack direction="inline" gap="small-200">
                  <s-text type="strong">{metrics.checkoutRate}%</s-text>
                  <s-badge tone="info">
                    {metrics.checkoutClicks} checkouts
                  </s-badge>
                </s-stack>
                <s-text color="subdued">{rangeLabel}</s-text>
              </s-grid>
            </s-box>

            <s-divider direction="block" />

            <s-box paddingBlock="small-400" paddingInline="small-100">
              <s-grid gap="small-300">
                <s-stack direction="inline" gap="small-200" align-items="center">
                  <s-icon type="product" tone="success" />
                  <s-heading>Upsell Add Rate</s-heading>
                </s-stack>
                <s-stack direction="inline" gap="small-200">
                  <s-text type="strong">{metrics.upsellAddRate}%</s-text>
                  <s-badge tone="success">
                    {metrics.upsellAdds} adds
                  </s-badge>
                </s-stack>
                <s-text color="subdued">{rangeLabel}</s-text>
              </s-grid>
            </s-box>

            <s-divider direction="block" />

            <s-box paddingBlock="small-400" paddingInline="small-100">
              <s-grid gap="small-300">
                <s-stack direction="inline" gap="small-200" align-items="center">
                  <s-icon type="view" tone="info" />
                  <s-heading>Drawer Opens</s-heading>
                </s-stack>
                <s-text type="strong">
                  {metrics.drawerOpens.toLocaleString()}
                </s-text>
                <s-text color="subdued">{rangeLabel}</s-text>
              </s-grid>
            </s-box>
          </s-grid>
        </s-section>

        {/* Daily Activity Chart */}
        <s-section heading="Daily Activity">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" align-items="center">
              <s-icon type="chart-histogram-flat" tone="info" />
              <s-text color="subdued">Drawer opens over time</s-text>
            </s-stack>
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: "2px",
                height: "160px",
                paddingTop: "8px",
              }}
            >
              {dailyData.map((d) => {
                const height = Math.max((d.opens / maxOpens) * 140, 2);
                return (
                  <div
                    key={d.date}
                    title={`${d.date}\n${d.opens} opens\n${d.adds} upsell adds\n${d.checkouts} checkouts`}
                    style={{
                      flex: 1,
                      height: `${height}px`,
                      backgroundColor:
                        d.opens > 0
                          ? "var(--p-color-bg-fill-info, #2C6ECB)"
                          : "var(--p-color-bg-surface-secondary, #ebebeb)",
                      borderRadius: "3px 3px 0 0",
                      minWidth: "3px",
                      cursor: "default",
                      transition: "height 0.2s ease",
                    }}
                  />
                );
              })}
            </div>
            <s-stack direction="inline" gap="base">
              <s-text color="subdued">{dailyData[0]?.date ?? ""}</s-text>
              <div style={{ flex: 1 }} />
              <s-text color="subdued">
                {dailyData[dailyData.length - 1]?.date ?? ""}
              </s-text>
            </s-stack>
          </s-stack>
        </s-section>

        {/* Conversion Funnel */}
        <s-section heading="Conversion Funnel">
          <s-stack direction="block" gap="base">
            <FunnelRow
              icon="view"
              label="Drawer Opens"
              value={metrics.drawerOpens}
              max={metrics.drawerOpens}
              tone="info"
            />
            <FunnelRow
              icon="cursor"
              label="Upsell Clicks"
              value={metrics.upsellClicks}
              max={metrics.drawerOpens}
              rate={metrics.upsellCTR}
              tone="info"
            />
            <FunnelRow
              icon="cart"
              label="Added to Cart"
              value={metrics.upsellAdds}
              max={metrics.drawerOpens}
              rate={metrics.upsellAddRate}
              tone="success"
            />
            <FunnelRow
              icon="payment"
              label="Checkout"
              value={metrics.checkoutClicks}
              max={metrics.drawerOpens}
              rate={metrics.checkoutRate}
              tone="success"
            />
          </s-stack>
        </s-section>

        {/* Footer help */}
        <s-stack alignItems="center">
          <s-text>
            Learn more about{" "}
            <s-link href="https://supercartd.com/docs/analytics" target="_blank">
              understanding your analytics
            </s-link>
            .
          </s-text>
        </s-stack>
      </s-stack>
    </s-page>
  );
}

function FunnelRow({
  icon,
  label,
  value,
  max,
  rate,
  tone,
}: {
  icon: "view" | "cursor" | "cart" | "payment";
  label: string;
  value: number;
  max: number;
  rate?: string;
  tone: "info" | "success";
}) {
  const pct = max > 0 ? Math.max((value / max) * 100, 1) : 0;

  return (
    <s-box padding="small-200">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="base" align-items="center">
          <s-icon type={icon} tone={tone} />
          <s-text type="strong">{label}</s-text>
          <div style={{ flex: 1 }} />
          <s-text>
            {value.toLocaleString()}
            {rate ? ` (${rate}%)` : ""}
          </s-text>
        </s-stack>
        <div
          style={{
            height: "8px",
            backgroundColor:
              "var(--p-color-bg-surface-secondary, #f3f3f3)",
            borderRadius: "var(--p-border-radius-100, 4px)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              backgroundColor:
                tone === "success"
                  ? "var(--p-color-bg-fill-success, #008060)"
                  : "var(--p-color-bg-fill-info, #2C6ECB)",
              borderRadius: "var(--p-border-radius-100, 4px)",
              transition: "width 0.3s ease",
            }}
          />
        </div>
      </s-stack>
    </s-box>
  );
}

export const ErrorBoundary = boundary.error;

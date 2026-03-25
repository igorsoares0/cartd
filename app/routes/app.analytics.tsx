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
    { opens: number; clicks: number; adds: number; checkouts: number; revenue: number }
  >();

  for (const e of events) {
    const day = e.createdAt.toISOString().slice(0, 10);
    if (!dailyMap.has(day)) {
      dailyMap.set(day, { opens: 0, clicks: 0, adds: 0, checkouts: 0, revenue: 0 });
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
  const days = range === "24h" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : 90;
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
    drawerOpens > 0 ? ((upsellClicks / drawerOpens) * 100).toFixed(1) : "0.0";
  const upsellAddRate =
    upsellClicks > 0 ? ((upsellAdds / upsellClicks) * 100).toFixed(1) : "0.0";
  const checkoutRate =
    drawerOpens > 0 ? ((checkoutClicks / drawerOpens) * 100).toFixed(1) : "0.0";

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
  const { range, rangeLabel, metrics, dailyData } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const maxOpens = Math.max(...dailyData.map((d) => d.opens), 1);
  const ranges: { key: TimeRange; label: string }[] = [
    { key: "24h", label: "24 hours" },
    { key: "7d", label: "7 days" },
    { key: "30d", label: "30 days" },
    { key: "all", label: "All time" },
  ];

  return (
    <s-page heading="Analytics">
      <s-stack direction="block" gap="large">
        {/* Overview header with time range tabs */}
        <s-box padding="large" borderWidth="base" borderRadius="base" background="base">
          <s-stack direction="block" gap="large">
            <s-stack direction="inline" gap="base" align-items="center" wrap="wrap">
              <s-text type="strong">Overview</s-text>
              <div style={{ flex: 1 }} />
              {ranges.map((r) => (
                <s-button
                  key={r.key}
                  variant={range === r.key ? "primary" : "tertiary"}
                  size="small"
                  onClick={() => setSearchParams({ range: r.key })}
                >
                  {r.label}
                </s-button>
              ))}
            </s-stack>

            {/* KPI metric cards — CSS grid for horizontal layout */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "24px" }}>
              <MetricCard
                label="Upsell Revenue"
                value={`$${metrics.upsellRevenue}`}
                sub={rangeLabel}
              />
              <MetricCard
                label="Checkout Rate"
                value={`${metrics.checkoutRate}%`}
                sub={`${metrics.checkoutClicks} checkouts`}
              />
              <MetricCard
                label="Upsell Add Rate"
                value={`${metrics.upsellAddRate}%`}
                sub={`${metrics.upsellAdds} adds`}
              />
              <MetricCard
                label="Drawer Opens"
                value={metrics.drawerOpens.toLocaleString()}
                sub={rangeLabel}
              />
            </div>
          </s-stack>
        </s-box>

        {/* Daily activity chart */}
        <s-box padding="large" borderWidth="base" borderRadius="base" background="base">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" align-items="center">
              <s-text type="strong">Daily Activity</s-text>
              <div style={{ flex: 1 }} />
              <s-text>Drawer opens over time</s-text>
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
                    title={`${d.date}\n${d.opens} opens · ${d.adds} upsell adds · ${d.checkouts} checkouts`}
                    style={{
                      flex: 1,
                      height: `${height}px`,
                      backgroundColor: d.opens > 0 ? "#7c3aed" : "#ebebeb",
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
              <s-text>{dailyData[0]?.date ?? ""}</s-text>
              <div style={{ flex: 1 }} />
              <s-text>{dailyData[dailyData.length - 1]?.date ?? ""}</s-text>
            </s-stack>
          </s-stack>
        </s-box>

        {/* Conversion funnel */}
        <s-box padding="large" borderWidth="base" borderRadius="base" background="base">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Conversion Funnel</s-text>
            <s-stack direction="block" gap="base">
              <FunnelRow
                label="Drawer Opens"
                value={metrics.drawerOpens}
                max={metrics.drawerOpens}
                color="#7c3aed"
              />
              <FunnelRow
                label="Upsell Clicks"
                value={metrics.upsellClicks}
                max={metrics.drawerOpens}
                color="#8b5cf6"
                rate={metrics.upsellCTR}
              />
              <FunnelRow
                label="Added to Cart"
                value={metrics.upsellAdds}
                max={metrics.drawerOpens}
                color="#a78bfa"
                rate={metrics.upsellAddRate}
              />
              <FunnelRow
                label="Checkout"
                value={metrics.checkoutClicks}
                max={metrics.drawerOpens}
                color="#c4b5fd"
                rate={metrics.checkoutRate}
              />
            </s-stack>
          </s-stack>
        </s-box>
      </s-stack>
    </s-page>
  );
}

function MetricCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div>
      <s-text>{label}</s-text>
      <div style={{ margin: "4px 0" }}>
        <s-heading>{value}</s-heading>
      </div>
      <s-text>{sub}</s-text>
    </div>
  );
}

function FunnelRow({
  label,
  value,
  max,
  color,
  rate,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  rate?: string;
}) {
  const pct = max > 0 ? Math.max((value / max) * 100, 1) : 0;
  return (
    <div>
      <s-stack direction="inline" gap="base" align-items="center">
        <s-text>{label}</s-text>
        <div style={{ flex: 1 }} />
        <s-text>
          {value.toLocaleString()}
          {rate ? ` (${rate}%)` : ""}
        </s-text>
      </s-stack>
      <div
        style={{
          height: "8px",
          backgroundColor: "var(--p-color-bg-surface-secondary, #f3f3f3)",
          borderRadius: "4px",
          overflow: "hidden",
          marginTop: "4px",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            backgroundColor: color,
            borderRadius: "4px",
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
  );
}

export const ErrorBoundary = boundary.error;

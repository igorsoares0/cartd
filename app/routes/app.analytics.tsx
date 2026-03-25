import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

type TimeRange = "7d" | "30d" | "90d";

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
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const since = daysAgo(days);

  const events = await prisma.analyticsEvent.findMany({
    where: {
      shop,
      createdAt: { gte: since },
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
  let estimatedRevenue = 0;

  // Daily breakdown for chart
  const dailyMap = new Map<string, {
    opens: number;
    clicks: number;
    adds: number;
    checkouts: number;
  }>();

  for (const e of events) {
    const day = e.createdAt.toISOString().slice(0, 10);
    if (!dailyMap.has(day)) {
      dailyMap.set(day, { opens: 0, clicks: 0, adds: 0, checkouts: 0 });
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
            // Use real revenue (product price) if available, fall back to legacy 'value'
            var rev = m.revenue != null ? m.revenue : m.value;
            if (rev != null) estimatedRevenue += Number(rev) || 0;
          } catch {}
        }
        break;
      case "checkout_click":
        checkoutClicks++;
        d.checkouts++;
        break;
    }
  }

  // Fill missing days
  const dailyData: Array<{
    date: string;
    opens: number;
    clicks: number;
    adds: number;
    checkouts: number;
  }> = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = d.toISOString().slice(0, 10);
    const entry = dailyMap.get(day) || { opens: 0, clicks: 0, adds: 0, checkouts: 0 };
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

  return {
    range,
    metrics: {
      drawerOpens,
      upsellClicks,
      upsellAdds,
      checkoutClicks,
      upsellCTR,
      upsellAddRate,
      checkoutRate,
      estimatedRevenue: estimatedRevenue.toFixed(2),
    },
    dailyData,
  };
};

export default function AnalyticsPage() {
  const { range, metrics, dailyData } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const maxOpens = Math.max(...dailyData.map((d) => d.opens), 1);

  return (
    <s-page heading="Analytics">
      <s-stack direction="block" gap="base">
        {/* Time range filter */}
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="inline" gap="base" align-items="center">
            <s-text type="strong">Time Range:</s-text>
            {(["7d", "30d", "90d"] as const).map((r) => (
              <s-button
                key={r}
                variant={range === r ? "primary" : "secondary"}
                onClick={() => setSearchParams({ range: r })}
              >
                {r === "7d" ? "7 Days" : r === "30d" ? "30 Days" : "90 Days"}
              </s-button>
            ))}
          </s-stack>
        </s-box>

        {/* KPI cards */}
        <s-grid grid-template-columns="1fr 1fr 1fr 1fr" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-text>Drawer Opens</s-text>
              <s-heading>{metrics.drawerOpens.toLocaleString()}</s-heading>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-text>Upsell CTR</s-text>
              <s-heading>{metrics.upsellCTR}%</s-heading>
              <s-text>
                {metrics.upsellClicks} clicks
              </s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-text>Upsell Add Rate</s-text>
              <s-heading>{metrics.upsellAddRate}%</s-heading>
              <s-text>
                {metrics.upsellAdds} adds
              </s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-text>Checkout Rate</s-text>
              <s-heading>{metrics.checkoutRate}%</s-heading>
              <s-text>
                {metrics.checkoutClicks} checkouts
              </s-text>
            </s-stack>
          </s-box>
        </s-grid>

        {/* Revenue card */}
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="inline" gap="base" align-items="center">
            <s-text type="strong">Upsell Revenue:</s-text>
            <s-heading>${metrics.estimatedRevenue}</s-heading>
          </s-stack>
        </s-box>

        {/* Daily chart — simple bar visualization */}
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-section heading="Daily Drawer Opens">
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: "2px",
                height: "180px",
                padding: "8px 0",
              }}
            >
              {dailyData.map((d) => {
                const height = Math.max((d.opens / maxOpens) * 160, 2);
                return (
                  <div
                    key={d.date}
                    title={`${d.date}: ${d.opens} opens`}
                    style={{
                      flex: 1,
                      height: `${height}px`,
                      backgroundColor: d.opens > 0 ? "#2C6ECB" : "#E4E5E7",
                      borderRadius: "2px 2px 0 0",
                      minWidth: "3px",
                      cursor: "default",
                    }}
                  />
                );
              })}
            </div>
            <s-stack direction="inline" gap="base">
              <s-text>
                {dailyData[0]?.date ?? ""}
              </s-text>
              <div style={{ flex: 1 }} />
              <s-text>
                {dailyData[dailyData.length - 1]?.date ?? ""}
              </s-text>
            </s-stack>
          </s-section>
        </s-box>

        {/* Conversion funnel */}
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-section heading="Conversion Funnel">
            <s-stack direction="block" gap="base">
              <FunnelBar
                label="Drawer Opens"
                value={metrics.drawerOpens}
                max={metrics.drawerOpens}
                color="#2C6ECB"
              />
              <FunnelBar
                label="Upsell Clicks"
                value={metrics.upsellClicks}
                max={metrics.drawerOpens}
                color="#5C6AC4"
              />
              <FunnelBar
                label="Upsell Added"
                value={metrics.upsellAdds}
                max={metrics.drawerOpens}
                color="#50B83C"
              />
              <FunnelBar
                label="Checkout Clicks"
                value={metrics.checkoutClicks}
                max={metrics.drawerOpens}
                color="#F49342"
              />
            </s-stack>
          </s-section>
        </s-box>
      </s-stack>
    </s-page>
  );
}

function FunnelBar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? Math.max((value / max) * 100, 1) : 0;
  return (
    <div>
      <s-stack direction="inline" gap="base" align-items="center">
        <s-text>{label}</s-text>
        <s-text>{value.toLocaleString()}</s-text>
      </s-stack>
      <div
        style={{
          height: "24px",
          backgroundColor: "#F4F6F8",
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

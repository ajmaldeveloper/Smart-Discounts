import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { getShopOverview } from "../services/shop.server";
import { getShopEntitlements } from "../services/entitlements.server";
import SupportWidget from "../components/SupportWidget";
import PlanBadge from "../components/PlanBadge";
import supportWidgetStyles from "../styles/support-widget.css?url";

// Below-the-fold (Get support) — fetchPriority: "low" so the browser
// doesn't compete with it against whatever's actually in the initial
// viewport.
export const links = () => [
  { rel: "stylesheet", href: supportWidgetStyles, fetchPriority: "low" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [overview, entitlements] = await Promise.all([getShopOverview(session.shop), getShopEntitlements(session.shop)]);

  return {
    shop: session.shop,
    shopName: overview?.shop.name ?? session.shop,
    planName: entitlements.plan.name,
    planCode: entitlements.effectivePlanCode,
    activeCampaigns: overview?.activeCampaigns ?? 0,
    draftCampaigns: overview?.draftCampaigns ?? 0,
  };
};

export default function Overview() {
  const { shop, shopName, planName, planCode, activeCampaigns, draftCampaigns } =
    useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const showSubscriptionSyncedNotice = searchParams.get("billing") === "subscription-synchronized";

  const totalCampaigns = activeCampaigns + draftCampaigns;
  const hasCampaign = totalCampaigns > 0;
  const isLive = activeCampaigns > 0;

  const statTiles = [
    {
      label: "Total campaigns",
      value: totalCampaigns,
      description: "Automatic and code campaigns combined",
      tone: undefined,
      href: "/app/campaigns",
    },
    {
      label: "Active",
      value: activeCampaigns,
      description: "Currently live",
      tone: "success" as const,
      href: "/app/campaigns?status=ACTIVE",
    },
    {
      label: "Draft",
      value: draftCampaigns,
      description: "Still being configured",
      tone: undefined,
      href: "/app/campaigns?status=DRAFT",
    },
  ] as const;

  return (
    <s-page heading={`Welcome, ${shopName}`}>
      <s-button slot="primary-action" icon="plus" href="/app/campaigns/new">
        Create campaign
      </s-button>

      {showSubscriptionSyncedNotice && (
        <s-banner tone="success" heading="Plan updated">
          Your plan is now {planName}.
        </s-banner>
      )}

      <s-section accessibilityLabel="Dashboard introduction">
        <s-grid gridTemplateColumns="minmax(0, 1.5fr) minmax(260px, 0.8fr)" gap="base">
          <s-box borderWidth="base" borderRadius="base" padding="large">
            <s-stack direction="block" gap="base">
              <s-badge tone={isLive ? "success" : "neutral"}>
                {isLive ? "Live" : "Getting started"}
              </s-badge>

              <s-heading>
                {isLive
                  ? `Winslet is running ${activeCampaigns} active campaign${activeCampaigns === 1 ? "" : "s"}`
                  : "Set up your first campaign"}
              </s-heading>

              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="small-200" alignItems="start">
                  <s-icon type="check-circle-filled" tone="success" />
                  <s-stack direction="block" gap="small-400">
                    <s-text>Store connected</s-text>
                    <s-text color="subdued">
                      Winslet is installed and can read your products, customers, and markets.
                    </s-text>
                  </s-stack>
                </s-stack>

                <s-stack direction="inline" gap="small-200" alignItems="start">
                  <s-icon
                    type={hasCampaign ? "check-circle-filled" : "circle"}
                    tone={hasCampaign ? "success" : undefined}
                    color={hasCampaign ? undefined : "subdued"}
                  />
                  <s-stack direction="block" gap="small-400">
                    <s-text color={hasCampaign ? "base" : "subdued"}>
                      First campaign created
                    </s-text>
                    <s-text color="subdued">
                      Set the reward, conditions, and audience for your first discount rule.
                    </s-text>
                    {!hasCampaign ? (
                      <s-link href="/app/campaigns/new">Create campaign</s-link>
                    ) : null}
                  </s-stack>
                </s-stack>

                <s-stack direction="inline" gap="small-200" alignItems="start">
                  <s-icon
                    type={isLive ? "check-circle-filled" : "circle"}
                    tone={isLive ? "success" : undefined}
                    color={isLive ? undefined : "subdued"}
                  />
                  <s-stack direction="block" gap="small-400">
                    <s-text color={isLive ? "base" : "subdued"}>
                      Campaign activated
                    </s-text>
                    <s-text color="subdued">
                      Publish a draft campaign so customers start seeing the discount.
                    </s-text>
                    {hasCampaign && !isLive ? (
                      <s-link href="/app/campaigns?status=DRAFT">Review drafts</s-link>
                    ) : null}
                  </s-stack>
                </s-stack>
              </s-stack>

              <s-button-group>
                <s-button variant="primary" icon="plus" href="/app/campaigns/new">
                  Create campaign
                </s-button>
                <s-button variant="secondary" href="/app/campaigns">
                  Manage campaigns
                </s-button>
              </s-button-group>
            </s-stack>
          </s-box>

          <s-box borderWidth="base" borderRadius="base" padding="large">
            <s-stack direction="block" gap="base">
              <PlanBadge planName={planName} planCode={planCode} />

              <s-stack direction="inline" alignItems="center" justifyContent="space-between">
                <s-text color="subdued">Active campaigns</s-text>
                <s-heading>{activeCampaigns}</s-heading>
              </s-stack>

              <s-stack direction="inline" alignItems="center" justifyContent="space-between">
                <s-text color="subdued">Draft campaigns</s-text>
                <s-heading>{draftCampaigns}</s-heading>
              </s-stack>

              <s-button variant="secondary" href="/app/plans">
                Manage plan
              </s-button>
            </s-stack>
          </s-box>
        </s-grid>
      </s-section>

      <s-section heading="Overview">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
          {statTiles.map((stat) => (
            <s-box
              key={stat.label}
              borderWidth="base"
              borderColor="subdued"
              borderRadius="base"
              overflow="hidden"
            >
              <s-clickable accessibilityLabel={`Show ${stat.label.toLowerCase()}`} href={stat.href}>
                <s-box padding="base">
                  <s-stack direction="block" gap="small-200">
                    {stat.tone ? (
                      <s-badge tone={stat.tone}>{stat.label}</s-badge>
                    ) : (
                      <s-text color="subdued">{stat.label}</s-text>
                    )}
                    <s-heading>{stat.value}</s-heading>
                    <s-text color="subdued">{stat.description}</s-text>
                  </s-stack>
                </s-box>
              </s-clickable>
            </s-box>
          ))}
        </s-grid>
      </s-section>

      <SupportWidget shop={shop} />
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

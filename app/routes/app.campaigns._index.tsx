import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { duplicateCampaign, getCampaign } from "../models/campaign.server";
import { archiveCampaign, deleteCampaignEverywhere, pauseCampaign, publishCampaign, resumeCampaign, unpublishCampaign } from "../services/discount-publish.server";
import { hasAnyReward, normalizeRewardConfig } from "../lib/reward-types";
import { useDeviceTimezone } from "../hooks/useDeviceTimezone";
import { displayStatus, hasFutureStart, statusBadgeTone } from "../lib/campaign-status";
import { relativeDayLabel } from "../lib/timezone";

type StatusFilter = "ALL" | "DRAFT" | "SCHEDULED" | "ACTIVE" | "PAUSED" | "ARCHIVED";
type SortMode = "UPDATED_DESC" | "UPDATED_ASC" | "NAME_ASC" | "NAME_DESC";

const STATUS_FILTERS: StatusFilter[] = ["ALL", "DRAFT", "SCHEDULED", "ACTIVE", "PAUSED", "ARCHIVED"];

const ACTION_INTENT = {
  PUBLISH: "publish",
  PAUSE: "pause",
  RESUME: "resume",
  EXPIRE: "expire",
  UNPUBLISH: "unpublish",
  DUPLICATE: "duplicate",
  DELETE: "delete",
} as const;

type ActionResult = { ok: boolean; intent: string; message: string; completedAt: number };

type OverlayElement = HTMLElement & { hideOverlay?: () => void };
function hideOverlay(id: string) {
  (document.getElementById(id) as OverlayElement | null)?.hideOverlay?.();
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });

  const campaigns = shop
    ? await db.campaign.findMany({
        where: { shopId: shop.id },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          name: true,
          status: true,
          kind: true,
          discountCode: true,
          updatedAt: true,
          publishedAt: true,
          rewardJson: true,
          scheduleStartAt: true,
          shopifyDiscountId: true,
        },
      })
    : [];

  // See app.campaigns.$id.tsx's matching hasUnpublishedChanges comment:
  // a merchant tightening the shop-wide cap/strategy in Settings makes
  // every already-live campaign's baked-in snapshot stale, not just
  // ones edited afterward — surfaced here as a shop-wide count so it's
  // visible without opening each campaign individually.
  const staleFromSettingsCount = campaigns.filter(
    (campaign) =>
      campaign.status === "ACTIVE" &&
      campaign.publishedAt !== null &&
      shop?.conflictSettingsUpdatedAt != null &&
      shop.conflictSettingsUpdatedAt.getTime() > campaign.publishedAt.getTime(),
  ).length;

  return {
    shopTimezone: shop?.timezone ?? "UTC",
    staleFromSettingsCount,
    campaigns: campaigns.map(({ rewardJson, ...campaign }) => ({
      ...campaign,
      updatedAt: campaign.updatedAt.toISOString(),
      publishedAt: campaign.publishedAt?.toISOString() ?? null,
      scheduleStartAt: campaign.scheduleStartAt?.toISOString() ?? null,
      needsAttention: !hasAnyReward(normalizeRewardConfig(rewardJson)),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const intent = String(formData.get("intent") ?? "");
  const campaignId = String(formData.get("campaignId") ?? "").trim();

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) {
    return { ok: false, intent, message: "Shop not found.", completedAt: Date.now() } satisfies ActionResult;
  }

  if (intent === ACTION_INTENT.DUPLICATE) {
    const duplicate = await duplicateCampaign(shop.id, campaignId);
    return duplicate
      ? ({ ok: true, intent, message: `Duplicated as "${duplicate.name}".`, completedAt: Date.now() } satisfies ActionResult)
      : ({ ok: false, intent, message: "That campaign no longer exists.", completedAt: Date.now() } satisfies ActionResult);
  }

  const campaign = await getCampaign(shop.id, campaignId);
  if (!campaign) {
    return { ok: false, intent, message: "That campaign no longer exists.", completedAt: Date.now() } satisfies ActionResult;
  }

  if (intent === ACTION_INTENT.PUBLISH) {
    const result = await publishCampaign(admin, campaign);
    return {
      ok: result.ok,
      intent,
      message: result.ok ? "Campaign published." : (result.message ?? "Could not publish this campaign."),
      completedAt: Date.now(),
    } satisfies ActionResult;
  }

  if (intent === ACTION_INTENT.PAUSE) {
    const result = await pauseCampaign(admin, campaign);
    return {
      ok: result.ok,
      intent,
      message: result.ok ? "Campaign paused." : (result.message ?? "Could not pause this campaign."),
      completedAt: Date.now(),
    } satisfies ActionResult;
  }

  if (intent === ACTION_INTENT.RESUME) {
    const result = await resumeCampaign(admin, campaign);
    return {
      ok: result.ok,
      intent,
      message: result.ok ? "Campaign resumed." : (result.message ?? "Could not resume this campaign."),
      completedAt: Date.now(),
    } satisfies ActionResult;
  }

  if (intent === ACTION_INTENT.EXPIRE) {
    const result = await archiveCampaign(admin, campaign);
    return {
      ok: result.ok,
      intent,
      message: result.ok ? "Campaign expired." : (result.message ?? "Could not expire this campaign."),
      completedAt: Date.now(),
    } satisfies ActionResult;
  }

  if (intent === ACTION_INTENT.UNPUBLISH) {
    const result = await unpublishCampaign(admin, campaign);
    return {
      ok: result.ok,
      intent,
      message: result.ok ? "Moved back to Draft." : (result.message ?? "Could not move this campaign back to Draft."),
      completedAt: Date.now(),
    } satisfies ActionResult;
  }

  if (intent === ACTION_INTENT.DELETE) {
    const result = await deleteCampaignEverywhere(admin, campaign);
    return {
      ok: result.ok,
      intent,
      message: result.ok ? "Campaign deleted." : (result.message ?? "Could not delete this campaign."),
      completedAt: Date.now(),
    } satisfies ActionResult;
  }

  return { ok: false, intent, message: "That action is not available.", completedAt: Date.now() } satisfies ActionResult;
};

function StatusMetric({
  label,
  value,
  detail,
  icon,
  tone,
}: {
  label: string;
  value: number;
  detail: string;
  icon: "apps" | "check-circle" | "edit" | "pause-circle" | "archive" | "calendar-time";
  tone: "neutral" | "success" | "info" | "warning" | "critical";
}) {
  return (
    <s-box padding="base" background="subdued" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-icon type={icon} tone={tone} />
          <s-text type="strong">{label}</s-text>
        </s-stack>
        <s-heading>{value}</s-heading>
        <s-text color="subdued">{detail}</s-text>
      </s-stack>
    </s-box>
  );
}

/**
 * Explicit IANA timeZone, not the ambient default: this component
 * renders during SSR too, where the runtime's local zone (often UTC on
 * a server) has nothing to do with the merchant's own device timezone
 * that the Schedule tab's date/time picker actually saved against —
 * without pinning it, the same instant shows a different clock time
 * depending on where this happened to render.
 */
function formatScheduledStart(scheduleStartAt: string, timeZone: string): string {
  const date = new Date(scheduleStartAt);
  const day = relativeDayLabel(date, timeZone) ?? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(date);
  return `${day}, ${time}`;
}

function formatUpdatedAt(updatedAt: string, timeZone: string): string {
  const date = new Date(updatedAt);
  return relativeDayLabel(date, timeZone) ?? new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeZone }).format(date);
}

export default function CampaignsIndex() {
  const { campaigns, shopTimezone, staleFromSettingsCount } = useLoaderData<typeof loader>();
  const timezone = useDeviceTimezone(shopTimezone);
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get("status");
  const fetcher = useFetcher<ActionResult>();
  const revalidator = useRevalidator();
  const shopify = useAppBridge();
  const handledAction = useRef<number | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    STATUS_FILTERS.includes(initialStatus as StatusFilter) ? (initialStatus as StatusFilter) : "ALL",
  );
  const [sortMode, setSortMode] = useState<SortMode>("UPDATED_DESC");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const busy = fetcher.state !== "idle";
  const pendingCampaignId = busy ? String(fetcher.formData?.get("campaignId") ?? "") : null;
  const pendingIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : null;

  const runCampaignAction = (intent: string, campaignId: string) => {
    if (busy) return;
    void fetcher.submit({ intent, campaignId }, { method: "post" });
  };

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || handledAction.current === fetcher.data.completedAt) return;

    handledAction.current = fetcher.data.completedAt;
    shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok, duration: 4000 });

    if (fetcher.data.ok && fetcher.data.intent === ACTION_INTENT.DELETE) {
      setDeleteTarget(null);
      hideOverlay("campaigns-delete-modal");
    }

    if (fetcher.data.ok) void revalidator.revalidate();
  }, [fetcher.data, fetcher.state, revalidator, shopify]);

  // Keeps everything current without a manual reload while any campaign
  // is still "Scheduled" — covers both a Draft waiting for
  // scheduled-publish.server.ts to auto-publish it, AND an already-
  // published campaign just waiting for its own startsAt to arrive on
  // Shopify's side. Without watching the latter too, the summary tiles
  // above (memoized on the campaigns array) would keep reporting stale
  // Published/Scheduled counts even after the per-row badge — computed
  // fresh on every render — had already moved on. Only polls while
  // there's something worth watching, and stops on its own once nothing
  // matches anymore.
  const hasPendingSchedule = campaigns.some((campaign) => hasFutureStart(campaign));
  useEffect(() => {
    if (!hasPendingSchedule || revalidator.state !== "idle") return;
    const id = setInterval(() => void revalidator.revalidate(), 10_000);
    return () => clearInterval(id);
  }, [hasPendingSchedule, revalidator]);

  const summary = useMemo(
    () => ({
      total: campaigns.length,
      // "Published" means genuinely live right now — a campaign that's
      // ACTIVE (published to Shopify) but whose own startsAt hasn't
      // arrived yet is Scheduled, not live, and shouldn't count here
      // even though its underlying DB status is the same ACTIVE.
      published: campaigns.filter((c) => c.status === "ACTIVE" && !hasFutureStart(c)).length,
      scheduled: campaigns.filter((c) => hasFutureStart(c)).length,
      draft: campaigns.filter((c) => c.status === "DRAFT" && !hasFutureStart(c)).length,
      paused: campaigns.filter((c) => c.status === "PAUSED").length,
      expired: campaigns.filter((c) => c.status === "ARCHIVED").length,
    }),
    [campaigns],
  );

  const visibleCampaigns = useMemo(() => {
    let list = campaigns;

    if (statusFilter === "SCHEDULED") {
      list = list.filter((c) => hasFutureStart(c));
    } else if (statusFilter !== "ALL") {
      list = list.filter((c) => c.status === statusFilter);
    }

    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(query));
    }

    return [...list].sort((a, b) => {
      switch (sortMode) {
        case "UPDATED_ASC":
          return a.updatedAt.localeCompare(b.updatedAt);
        case "NAME_ASC":
          return a.name.localeCompare(b.name);
        case "NAME_DESC":
          return b.name.localeCompare(a.name);
        case "UPDATED_DESC":
        default:
          return b.updatedAt.localeCompare(a.updatedAt);
      }
    });
  }, [campaigns, statusFilter, searchQuery, sortMode]);

  return (
    <s-page heading="Campaigns">
      <s-button slot="primary-action" href="/app/campaigns/new">
        Create campaign
      </s-button>

      {campaigns.length === 0 ? (
        <s-section>
          <s-box padding="large">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-icon type="info" />
              <s-heading>Create your first campaign</s-heading>
              <s-paragraph>
                Set conditions, discounts, schedules and usage limits, then publish it as a real Shopify discount.
              </s-paragraph>
              <s-button variant="primary" href="/app/campaigns/new">
                Create campaign
              </s-button>
            </s-stack>
          </s-box>
        </s-section>
      ) : (
        <>
          {staleFromSettingsCount > 0 && (
            <s-banner tone="warning" heading="Your conflict resolution settings changed">
              <s-paragraph>
                {staleFromSettingsCount} active {staleFromSettingsCount === 1 ? "campaign" : "campaigns"} published before your latest cap/strategy
                change in Settings — open and republish each one to apply it at checkout.
              </s-paragraph>
            </s-banner>
          )}

          <s-section heading="Overview">
            <s-grid gridTemplateColumns="repeat(3, minmax(160px, 1fr))" gap="base">
              <StatusMetric label="Total campaigns" value={summary.total} detail="Automatic and code combined" icon="apps" tone="neutral" />
              <StatusMetric label="Published" value={summary.published} detail="Currently live" icon="check-circle" tone="success" />
              <StatusMetric label="Scheduled" value={summary.scheduled} detail="Starts at a future date" icon="calendar-time" tone="info" />
              <StatusMetric label="Draft" value={summary.draft} detail="Still being configured" icon="edit" tone="info" />
              <StatusMetric label="Paused" value={summary.paused} detail="Not currently applying" icon="pause-circle" tone="warning" />
              <StatusMetric label="Expired" value={summary.expired} detail="Archived campaigns" icon="archive" tone="critical" />
            </s-grid>
          </s-section>

          <s-section heading="All campaigns">
            <s-stack direction="block" gap="base">
              <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
                <s-paragraph>Search, filter, and manage any campaign.</s-paragraph>
                <s-badge tone="info">
                  {visibleCampaigns.length} {visibleCampaigns.length === 1 ? "campaign" : "campaigns"}
                </s-badge>
              </s-grid>

              <s-grid gridTemplateColumns="minmax(280px, 2fr) minmax(160px, 1fr) minmax(160px, 1fr)" gap="small" alignItems="end">
                <s-search-field
                  label="Search campaigns"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="Search campaigns"
                  value={searchQuery}
                  onInput={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
                    const target = (event.target ?? event.currentTarget) as { value?: string } | null;
                    setSearchQuery(target?.value ?? "");
                  }}
                />

                <s-select
                  label="Status"
                  labelAccessibilityVisibility="exclusive"
                  value={statusFilter}
                  onChange={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
                    const target = (event.target ?? event.currentTarget) as { value?: string } | null;
                    setStatusFilter((target?.value as StatusFilter) ?? "ALL");
                  }}
                >
                  <s-option value="ALL">All statuses</s-option>
                  <s-option value="ACTIVE">Active</s-option>
                  <s-option value="DRAFT">Draft</s-option>
                  <s-option value="SCHEDULED">Scheduled</s-option>
                  <s-option value="PAUSED">Paused</s-option>
                  <s-option value="ARCHIVED">Archived</s-option>
                </s-select>

                <s-select
                  label="Sort by"
                  labelAccessibilityVisibility="exclusive"
                  value={sortMode}
                  onChange={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
                    const target = (event.target ?? event.currentTarget) as { value?: string } | null;
                    setSortMode((target?.value as SortMode) ?? "UPDATED_DESC");
                  }}
                >
                  <s-option value="UPDATED_DESC">Recently updated</s-option>
                  <s-option value="UPDATED_ASC">Oldest updated</s-option>
                  <s-option value="NAME_ASC">Name A–Z</s-option>
                  <s-option value="NAME_DESC">Name Z–A</s-option>
                </s-select>
              </s-grid>

              {visibleCampaigns.length === 0 ? (
                <s-box padding="large" borderWidth="base" borderRadius="base">
                  <s-stack direction="block" gap="base" alignItems="center">
                    <s-icon type="info" />
                    <s-heading>No matching campaigns</s-heading>
                    <s-paragraph>Try a different search term or status filter.</s-paragraph>
                  </s-stack>
                </s-box>
              ) : (
                <s-box background="strong" borderWidth="base" borderRadius="base" overflow="hidden">
                  <s-table>
                    <s-table-header-row>
                      <s-table-header listSlot="primary">Name</s-table-header>
                      <s-table-header listSlot="inline">Status</s-table-header>
                      <s-table-header listSlot="labeled">Type</s-table-header>
                      <s-table-header listSlot="labeled">Code</s-table-header>
                      <s-table-header listSlot="labeled">Last updated</s-table-header>
                      <s-table-header listSlot="inline">Actions</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {visibleCampaigns.map((campaign) => {
                        const menuId = `campaign-actions-${campaign.id}`;
                        const rowBusy = pendingCampaignId === campaign.id;

                        return (
                          <s-table-row key={campaign.id}>
                            <s-table-cell>
                              <s-link href={`/app/campaigns/${campaign.id}`}>{campaign.name}</s-link>
                            </s-table-cell>
                            <s-table-cell>
                              <s-stack direction="block" gap="small-400">
                                <s-badge tone={statusBadgeTone(displayStatus(campaign))}>{displayStatus(campaign)}</s-badge>
                                {hasFutureStart(campaign) && (
                                  <s-text color="subdued">Starts {formatScheduledStart(campaign.scheduleStartAt as string, timezone)}</s-text>
                                )}
                              </s-stack>
                            </s-table-cell>
                            <s-table-cell>
                              <s-badge>{campaign.kind}</s-badge>
                            </s-table-cell>
                            <s-table-cell>
                              {campaign.kind === "CODE" && campaign.discountCode ? (
                                <s-text>{campaign.discountCode}</s-text>
                              ) : (
                                <s-text color="subdued">—</s-text>
                              )}
                            </s-table-cell>
                            <s-table-cell>{formatUpdatedAt(campaign.updatedAt, timezone)}</s-table-cell>
                            <s-table-cell>
                              <s-button
                                icon="menu-horizontal"
                                variant="tertiary"
                                accessibilityLabel={`Actions for ${campaign.name}`}
                                commandFor={menuId}
                                loading={rowBusy}
                                disabled={busy && !rowBusy}
                              />

                              <s-menu id={menuId} accessibilityLabel={`Actions for ${campaign.name}`}>
                                <s-button icon="view" href={`/app/campaigns/${campaign.id}`} disabled={busy}>
                                  Open
                                </s-button>

                                {campaign.status === "ACTIVE" ? (
                                  <s-button
                                    icon="pause-circle"
                                    disabled={busy}
                                    loading={rowBusy && pendingIntent === ACTION_INTENT.PAUSE}
                                    onClick={() => runCampaignAction(ACTION_INTENT.PAUSE, campaign.id)}
                                  >
                                    Pause
                                  </s-button>
                                ) : campaign.status !== "PAUSED" && campaign.needsAttention ? (
                                  <s-button icon="alert-triangle" tone="critical" href={`/app/campaigns/${campaign.id}?tab=reward`}>
                                    Needs attention
                                  </s-button>
                                ) : (
                                  <s-button
                                    icon="check-circle"
                                    disabled={busy}
                                    loading={rowBusy && (pendingIntent === ACTION_INTENT.PUBLISH || pendingIntent === ACTION_INTENT.RESUME)}
                                    onClick={() =>
                                      runCampaignAction(
                                        // A discount that's already been created on Shopify (Paused, or
                                        // Expired/Archived — "Expire" only deactivates, it doesn't delete)
                                        // needs the activate mutation to actually turn back on; re-running
                                        // Publish's update path would just push field changes without ever
                                        // flipping Shopify's own enabled/disabled state.
                                        campaign.shopifyDiscountId ? ACTION_INTENT.RESUME : ACTION_INTENT.PUBLISH,
                                        campaign.id,
                                      )
                                    }
                                  >
                                    {campaign.status === "PAUSED" ? "Resume" : campaign.shopifyDiscountId ? "Reactivate" : "Publish"}
                                  </s-button>
                                )}

                                {campaign.status === "ACTIVE" || campaign.status === "PAUSED" ? (
                                  <>
                                    <s-button
                                      icon="undo"
                                      disabled={busy}
                                      loading={rowBusy && pendingIntent === ACTION_INTENT.UNPUBLISH}
                                      onClick={() => runCampaignAction(ACTION_INTENT.UNPUBLISH, campaign.id)}
                                    >
                                      Move to Draft
                                    </s-button>
                                    <s-button
                                      icon="archive"
                                      disabled={busy}
                                      loading={rowBusy && pendingIntent === ACTION_INTENT.EXPIRE}
                                      onClick={() => runCampaignAction(ACTION_INTENT.EXPIRE, campaign.id)}
                                    >
                                      Expire
                                    </s-button>
                                  </>
                                ) : null}

                                <s-button
                                  icon="duplicate"
                                  disabled={busy}
                                  loading={rowBusy && pendingIntent === ACTION_INTENT.DUPLICATE}
                                  onClick={() => runCampaignAction(ACTION_INTENT.DUPLICATE, campaign.id)}
                                >
                                  Duplicate
                                </s-button>

                                <s-button
                                  icon="delete"
                                  tone="critical"
                                  disabled={busy}
                                  commandFor="campaigns-delete-modal"
                                  command="--show"
                                  onClick={() => setDeleteTarget({ id: campaign.id, name: campaign.name })}
                                >
                                  Delete
                                </s-button>
                              </s-menu>
                            </s-table-cell>
                          </s-table-row>
                        );
                      })}
                    </s-table-body>
                  </s-table>
                </s-box>
              )}
            </s-stack>
          </s-section>
        </>
      )}

      <s-modal id="campaigns-delete-modal" heading={deleteTarget ? `Delete "${deleteTarget.name}"?` : "Delete campaign?"}>
        <s-stack direction="block" gap="base">
          <s-paragraph>
            This campaign, its Shopify discount, and its recorded analytics will be permanently deleted.
          </s-paragraph>
          <s-paragraph>This action cannot be undone.</s-paragraph>
        </s-stack>

        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor="campaigns-delete-modal"
          command="--hide"
          disabled={pendingIntent === ACTION_INTENT.DELETE}
        >
          Cancel
        </s-button>

        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={pendingIntent === ACTION_INTENT.DELETE}
          disabled={!deleteTarget}
          onClick={() => {
            if (!deleteTarget) return;
            runCampaignAction(ACTION_INTENT.DELETE, deleteTarget.id);
          }}
        >
          Delete campaign
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

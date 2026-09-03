import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useLocation, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  duplicateCampaign,
  getCampaign,
  updateCampaignConditions,
  updateCampaignGeneral,
  updateCampaignReward,
  updateCampaignSchedule,
  updateCampaignStacking,
} from "../models/campaign.server";
import { findConditionGroupById, parseConditionTree } from "../lib/campaign-types";
import {
  editableEmptyGroup,
  findManagedGroup,
  setManagedLeaves,
  toConditionTree,
  toEditableTree,
  type EditableGroup,
  type EditableLeaf,
} from "../lib/condition-tree-edit";
import { hasAnyReward, normalizeRewardConfig, type RewardConfig } from "../lib/reward-types";
import { utcIsoToZonedParts, zonedTimeToUtcIso } from "../lib/timezone";
import { displayStatus, statusBadgeTone } from "../lib/campaign-status";
import { useDeviceTimezone } from "../hooks/useDeviceTimezone";
import ConditionsEditor from "../components/campaign-builder/ConditionsEditor";
import RewardEditor from "../components/campaign-builder/RewardEditor";
import AudienceEditor from "../components/campaign-builder/AudienceEditor";
import ProductsEditor from "../components/campaign-builder/ProductsEditor";
import MarketsEditor from "../components/campaign-builder/MarketsEditor";
import {
  archiveCampaign,
  deleteCampaignEverywhere,
  pauseCampaign,
  publishCampaign,
  resumeCampaign,
  unpublishCampaign,
} from "../services/discount-publish.server";
import {
  hydrateCollectionRefs,
  hydrateProductRefs,
  resolveMarketCountryCodes,
  searchMarkets,
  type HydratedResourceRef,
} from "../services/shopify-resources.server";
import {
  getShopEntitlements,
  requireStackingAccess,
  requireTiersAccess,
  requireFreeGiftBogoAccess,
  requireMinimumRequirementAccess,
  requireCustomerTargetingAccess,
  requireProductTargetingAccess,
  requireMarketTargetingAccess,
} from "../services/entitlements.server";
import { PlanAccessError } from "../services/plans.server";

const AUDIENCE_GROUP_ID = "managed:audience";
const PRODUCTS_GROUP_ID = "managed:products";
const MARKETS_GROUP_ID = "managed:markets";

type ActionData = { error?: string; notice?: string };

type OverlayElement = HTMLElement & { hideOverlay?: () => void };
function hideOverlay(id: string) {
  (document.getElementById(id) as OverlayElement | null)?.hideOverlay?.();
}

const TABS = ["general", "conditions", "audience", "products", "markets", "reward", "schedule", "stacking"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  general: "General",
  conditions: "Conditions",
  audience: "Customers",
  products: "Products",
  markets: "Markets",
  reward: "Discount",
  schedule: "Schedule",
  stacking: "Stacking",
};

const CREATE_NOTICES: Record<string, string> = {
  created: "Campaign created.",
  duplicated: "Campaign duplicated.",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id;
  // A bad/stale/deleted campaign ID lands here just like an unmatched
  // /app/* path (see app.$.tsx) — redirect to /app instead of throwing
  // a 404 Response, which app.tsx's ErrorBoundary would otherwise
  // render as a bare "404" with no way back into the app.
  if (!id) return redirect("/app");

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  const campaign = shop ? await getCampaign(shop.id, id) : null;

  if (!campaign) return redirect("/app");

  const url = new URL(request.url);
  const noticeParam = url.searchParams.get("notice");

  const conditionsTree = parseConditionTree(campaign.conditionsJson);
  const productsGroup = findConditionGroupById(conditionsTree, PRODUCTS_GROUP_ID);

  function stringIdsFor(field: string): string[] {
    const leaf = productsGroup?.children.find((c) => c.type === "condition" && c.field === field);
    const value = leaf && leaf.type === "condition" ? leaf.value : undefined;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  }

  const reward = normalizeRewardConfig(campaign.rewardJson);

  // Buy X Get Y Free's free-gift products (TierBreak.freeProductIds)
  // live in the reward config, not the Products tab's own condition
  // tree — without this, BogoEditor's picker has no title/image to
  // show for them and falls back to displaying the raw product GIDs.
  const freeGiftProductIds = [...(reward.product?.tiers ?? []), ...(reward.order?.tiers ?? [])].flatMap((tier) => tier.freeProductIds ?? []);

  const [productRefs, collectionRefs, marketRefs] = await Promise.all([
    hydrateProductRefs(admin, [...new Set([...stringIdsFor("product.id"), ...freeGiftProductIds])]),
    hydrateCollectionRefs(admin, stringIdsFor("collection.id")),
    searchMarkets(admin, "", 50),
  ]);

  const markets = await Promise.all(
    marketRefs.map(async (market) => ({
      id: market.id,
      title: market.title,
      countryCodes: await resolveMarketCountryCodes(admin, market.id),
    })),
  );
  const allCountries = [...new Set(markets.flatMap((market) => market.countryCodes))].sort();

  const entitlements = await getShopEntitlements(session.shop);

  return {
    planFeatures: entitlements.plan.features,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      kind: campaign.kind,
      status: campaign.status,
      discountCode: campaign.discountCode,
      shopifyDiscountId: campaign.shopifyDiscountId,
      // Full ISO datetime, not date-only — the Schedule tab's time
      // inputs need the time-of-day portion to redisplay correctly.
      scheduleStartAt: campaign.scheduleStartAt ? campaign.scheduleStartAt.toISOString() : "",
      scheduleEndAt: campaign.scheduleEndAt ? campaign.scheduleEndAt.toISOString() : "",
      priority: campaign.priority,
      isExclusive: campaign.isExclusive,
      usageLimitTotal: campaign.usageLimitTotal,
      usageLimitPerCustomer: campaign.usageLimitPerCustomer,
      usageCount: campaign.usageCount,
      // True when a live campaign's row has been saved (any tab) since
      // its own last successful publish — Save always writes straight
      // to our database, but Shopify's Discount node only reflects a
      // snapshot from whenever Publish/Republish was last clicked.
      // Timestamp-based, not a re-diff of every field: publishing sets
      // both publishedAt and (via @updatedAt) updatedAt to the same
      // moment, so any later save unavoidably pushes updatedAt past it.
      // Also true when the shop's own conflict cap/strategy changed
      // since this campaign's last publish — its compiled snapshot
      // baked in whatever the cap was AT THAT TIME (see
      // campaign-compiler.server.ts), so a merchant tightening the cap
      // in Settings needs every already-live campaign to know it's now
      // stale too, not just ones they happen to edit afterward.
      hasUnpublishedChanges:
        campaign.status === "ACTIVE" &&
        campaign.publishedAt !== null &&
        (campaign.updatedAt.getTime() > campaign.publishedAt.getTime() ||
          (shop?.conflictSettingsUpdatedAt !== undefined &&
            shop?.conflictSettingsUpdatedAt !== null &&
            shop.conflictSettingsUpdatedAt.getTime() > campaign.publishedAt.getTime())),
    },
    conditionsTree,
    reward,
    currencyCode: shop?.currencyCode ?? "USD",
    shopTimezone: shop?.timezone ?? "UTC",
    productRefs,
    collectionRefs,
    markets,
    allCountries,
    loadNotice: noticeParam ? (CREATE_NOTICES[noticeParam] ?? null) : null,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Campaign ID is required.", { status: 400 });

  const shop = await db.shop.findUnique({ where: { domain: session.shop } });
  if (!shop) throw new Response("Shop not found.", { status: 404 });

  const formData = await request.formData();
  const actionType = String(formData.get("_action") ?? "");

  if (actionType === "saveGeneral") {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { error: "Enter a name for this campaign." } satisfies ActionData;

    const updated = await updateCampaignGeneral(shop.id, id, {
      name,
      discountCode: String(formData.get("discountCode") ?? ""),
    });

    if (!updated) return { error: "Unable to save the campaign." } satisfies ActionData;

    // Mirrors wholesale-registration's Published/Unpublished-changes
    // pattern (see the header's Republish button below): Save always
    // updates our own record, but never silently pushes to Shopify —
    // a live campaign's title/analytics-attribution only actually
    // updates once the merchant explicitly clicks Republish.
    return { notice: "Saved." } satisfies ActionData;
  }

  if (actionType === "saveConditions") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(formData.get("conditionsJson") ?? "{}"));
    } catch {
      return { error: "Conditions could not be saved — invalid data." } satisfies ActionData;
    }

    const submittedTree = parseConditionTree(parsed);
    const managedGroupHasLeaves = (groupId: string) => (findConditionGroupById(submittedTree, groupId)?.children.length ?? 0) > 0;

    try {
      if (managedGroupHasLeaves(AUDIENCE_GROUP_ID)) await requireCustomerTargetingAccess(session.shop);
      if (managedGroupHasLeaves(PRODUCTS_GROUP_ID)) await requireProductTargetingAccess(session.shop);
      if (managedGroupHasLeaves(MARKETS_GROUP_ID)) await requireMarketTargetingAccess(session.shop);
    } catch (error) {
      if (error instanceof PlanAccessError) {
        return { error: `${error.message} Visit Plans to upgrade.` } satisfies ActionData;
      }
      throw error;
    }

    const updated = await updateCampaignConditions(shop.id, id, parsed);
    if (!updated) return { error: "Unable to save conditions." } satisfies ActionData;

    const notice = String(formData.get("notice") ?? "").trim();
    return { notice: notice || "Conditions saved." } satisfies ActionData;
  }

  if (actionType === "saveReward") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(formData.get("rewardJson") ?? "{}"));
    } catch {
      return { error: "Discount could not be saved — invalid data." } satisfies ActionData;
    }

    const normalized = normalizeRewardConfig(parsed);
    const tierRewards = [normalized.product, normalized.order].filter((reward): reward is NonNullable<typeof reward> => Boolean(reward));
    const usesTiers = tierRewards.some((reward) => (reward.tiers?.length ?? 0) > 0);
    const usesFreeGiftBogo = tierRewards.some((reward) => reward.tiers?.some((tier) => tier.freeProductIds?.length));
    const usesMinimumRequirement = [normalized.product, normalized.order, normalized.shipping].some((reward) => reward?.minimumValue !== undefined);

    try {
      if (usesTiers) await requireTiersAccess(session.shop);
      if (usesFreeGiftBogo) await requireFreeGiftBogoAccess(session.shop);
      if (usesMinimumRequirement) await requireMinimumRequirementAccess(session.shop);
    } catch (error) {
      if (error instanceof PlanAccessError) {
        return { error: `${error.message} Visit Plans to upgrade.` } satisfies ActionData;
      }
      throw error;
    }

    const updated = await updateCampaignReward(shop.id, id, parsed);
    if (!updated) return { error: "Unable to save the discount." } satisfies ActionData;

    return { notice: "Discount saved." } satisfies ActionData;
  }

  if (actionType === "saveSchedule") {
    const startsAt = String(formData.get("startsAt") ?? "").trim();
    const endsAt = String(formData.get("endsAt") ?? "").trim();

    const updated = await updateCampaignSchedule(shop.id, id, {
      startsAt: startsAt || null,
      endsAt: endsAt || null,
    });

    if (!updated) return { error: "Unable to save schedule — check that the end date is after the start date." } satisfies ActionData;

    // If the start time the merchant just saved has already passed (they
    // picked a past moment, or simply took a while to hit Save), don't
    // leave it sitting inert in Draft for up to ~20s until the next
    // scheduled-publish.server.ts tick notices — publish it right now,
    // same as clicking Publish themselves.
    if (updated.status === "DRAFT" && updated.scheduleStartAt && updated.scheduleStartAt.getTime() <= Date.now()) {
      const result = await publishCampaign(admin, updated);
      if (!result.ok) {
        return { error: `Schedule saved, but publishing failed: ${result.message ?? "Shopify rejected this campaign."}` } satisfies ActionData;
      }
      return { notice: "Schedule saved — its start time already passed, so it published immediately." } satisfies ActionData;
    }

    return { notice: "Schedule saved." } satisfies ActionData;
  }

  if (actionType === "saveStacking") {
    const priority = Number(formData.get("priority") ?? 0) || 0;
    const isExclusive = formData.get("isExclusive") === "true";

    const usageLimitTotalRaw = String(formData.get("usageLimitTotal") ?? "").trim();
    const usageLimitPerCustomerRaw = String(formData.get("usageLimitPerCustomer") ?? "").trim();
    const usageLimitTotal = usageLimitTotalRaw ? Number(usageLimitTotalRaw) : null;
    const usageLimitPerCustomer = usageLimitPerCustomerRaw ? Number(usageLimitPerCustomerRaw) : null;

    if (usageLimitTotal !== null && (!Number.isFinite(usageLimitTotal) || usageLimitTotal < 1)) {
      return { error: "Total usage limit must be a whole number of 1 or more." } satisfies ActionData;
    }
    if (usageLimitPerCustomer !== null && (!Number.isFinite(usageLimitPerCustomer) || usageLimitPerCustomer < 1)) {
      return { error: "Per-customer usage limit must be a whole number of 1 or more." } satisfies ActionData;
    }

    // The conflict engine's shop-wide default always applies regardless
    // of plan — this only gates a campaign overriding it with its own
    // priority/exclusivity/usage-limit values.
    const usesStackingOverrides = priority !== 0 || isExclusive || usageLimitTotal !== null || usageLimitPerCustomer !== null;
    if (usesStackingOverrides) {
      try {
        await requireStackingAccess(session.shop);
      } catch (error) {
        if (error instanceof PlanAccessError) {
          return { error: `${error.message} Visit Plans to upgrade.` } satisfies ActionData;
        }
        throw error;
      }
    }

    const updated = await updateCampaignStacking(shop.id, id, { priority, isExclusive, usageLimitTotal, usageLimitPerCustomer });
    if (!updated) return { error: "Unable to save stacking settings." } satisfies ActionData;
    return { notice: "Stacking settings saved." } satisfies ActionData;
  }

  if (actionType === "publish") {
    const campaign = await getCampaign(shop.id, id);
    if (!campaign) return { error: "Campaign not found." } satisfies ActionData;

    try {
      const result = await publishCampaign(admin, campaign);
      if (!result.ok) return { error: result.message ?? "Unable to publish this campaign." } satisfies ActionData;
      return { notice: "Campaign published — now live at checkout." } satisfies ActionData;
    } catch (error) {
      console.error("[Winslet] Publish failed:", error);
      return { error: "Unable to publish this campaign. Check the server logs for details." } satisfies ActionData;
    }
  }

  if (actionType === "resume") {
    const campaign = await getCampaign(shop.id, id);
    if (!campaign) return { error: "Campaign not found." } satisfies ActionData;

    try {
      const result = await resumeCampaign(admin, campaign);
      if (!result.ok) return { error: result.message ?? "Unable to resume this campaign." } satisfies ActionData;
      return { notice: "Campaign resumed — active again at checkout." } satisfies ActionData;
    } catch (error) {
      console.error("[Winslet] Resume failed:", error);
      return { error: "Unable to resume this campaign. Check the server logs for details." } satisfies ActionData;
    }
  }

  if (actionType === "pause") {
    const campaign = await getCampaign(shop.id, id);
    if (!campaign) return { error: "Campaign not found." } satisfies ActionData;

    const result = await pauseCampaign(admin, campaign);
    return result.ok
      ? ({ notice: "Campaign paused." } satisfies ActionData)
      : ({ error: result.message ?? "Unable to pause this campaign." } satisfies ActionData);
  }

  if (actionType === "unpublish") {
    const campaign = await getCampaign(shop.id, id);
    if (!campaign) return { error: "Campaign not found." } satisfies ActionData;

    const result = await unpublishCampaign(admin, campaign);
    return result.ok
      ? ({ notice: "Moved back to Draft." } satisfies ActionData)
      : ({ error: result.message ?? "Unable to move this campaign back to Draft." } satisfies ActionData);
  }

  if (actionType === "expire") {
    const campaign = await getCampaign(shop.id, id);
    if (!campaign) return { error: "Campaign not found." } satisfies ActionData;

    const result = await archiveCampaign(admin, campaign);
    return result.ok
      ? ({ notice: "Campaign expired." } satisfies ActionData)
      : ({ error: result.message ?? "Unable to expire this campaign." } satisfies ActionData);
  }

  if (actionType === "duplicate") {
    const duplicate = await duplicateCampaign(shop.id, id);
    if (!duplicate) return { error: "That campaign no longer exists." } satisfies ActionData;
    return redirect(`/app/campaigns/${duplicate.id}?notice=duplicated`);
  }

  if (actionType === "delete") {
    const campaign = await getCampaign(shop.id, id);
    if (!campaign) return { error: "Campaign not found." } satisfies ActionData;

    const result = await deleteCampaignEverywhere(admin, campaign);
    if (!result.ok) return { error: result.message ?? "Unable to delete this campaign." } satisfies ActionData;
    return redirect("/app/campaigns");
  }

  return { error: "Unknown action." } satisfies ActionData;
};

function leavesOf(group: EditableGroup | undefined): EditableLeaf[] {
  return group ? group.children.filter((c): c is EditableLeaf => c.type === "condition") : [];
}

/**
 * The tab itself always stays reachable and in the nav — a shop
 * without the feature sees this in-page prompt instead of the real
 * editor, rather than the tab being hidden or redirected away (hiding
 * features reads as broken/incomplete to a merchant evaluating the
 * app). The server-side saveReward/saveStacking branches enforce the
 * same gate independently; this is only the UI half.
 */
function UpgradePrompt({ feature }: { feature: string }) {
  return (
    <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="large-500">
      <s-stack direction="block" gap="small" alignItems="center">
        <s-text type="strong">{feature} needs an upgrade</s-text>
        <s-text color="subdued">Your current plan doesn&apos;t include {feature.toLowerCase()}.</s-text>
        <s-button variant="primary" href="/app/plans">
          View plans
        </s-button>
      </s-stack>
    </s-box>
  );
}

// The Schedule tab's date+time inputs are split fields, but the stored
// value (and Shopify's own startsAt/endsAt) is one UTC ISO datetime.
// The merchant types a wall-clock time meaning "in my store's own
// timezone" — zonedTimeToUtcIso/utcIsoToZonedParts (app/lib/timezone.ts)
// convert both directions against shop.timezone, so "6:30 PM" actually
// launches at 6:30 PM store time, not 6:30 PM UTC.
function datePartOf(iso: string, timeZone: string): string {
  return utcIsoToZonedParts(iso, timeZone).date;
}
function timePartOf(iso: string, fallback: string, timeZone: string): string {
  return iso ? utcIsoToZonedParts(iso, timeZone).time : fallback;
}
function combineDateTime(date: string, time: string, timeZone: string): string {
  return date ? zonedTimeToUtcIso(date, time, timeZone) : "";
}

// Full minute precision, 24-hour "HH:MM" value (matches combineDateTime/
// timePartOf) — three small side-by-side selects (hour/minute/AM-PM),
// Slack-style, instead of one long dropdown of fixed time-of-day slots.
const HOUR_OPTIONS = Array.from({ length: 12 }, (_, index) => String(index + 1));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));

function splitTime24(value: string): { hour12: string; minute: string; period: "AM" | "PM" } {
  const [hourRaw, minuteRaw] = (value || "00:00").split(":");
  const hour24 = Number(hourRaw) || 0;
  const period: "AM" | "PM" = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return { hour12: String(hour12), minute: (minuteRaw ?? "00").padStart(2, "0"), period };
}

function joinTime24(hour12: string, minute: string, period: "AM" | "PM"): string {
  const hour24 = (Number(hour12) % 12) + (period === "PM" ? 12 : 0);
  return `${String(hour24).padStart(2, "0")}:${minute}`;
}

function TimeFields({ label, value, onChange }: { label: string; value: string; onChange: (next: string) => void }) {
  const { hour12, minute, period } = splitTime24(value);

  return (
    <s-stack direction="block" gap="small-200">
      <s-text color="subdued">{label}</s-text>
      <s-grid gridTemplateColumns="repeat(3, minmax(64px, 1fr))" gap="small-200">
        <s-select
          label="Hour"
          value={hour12}
          onChange={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
            const target = (event.target ?? event.currentTarget) as { value?: string } | null;
            onChange(joinTime24(target?.value ?? hour12, minute, period));
          }}
        >
          {HOUR_OPTIONS.map((hour) => (
            <s-option key={hour} value={hour}>
              {hour}
            </s-option>
          ))}
        </s-select>

        <s-select
          label="Minute"
          value={minute}
          onChange={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
            const target = (event.target ?? event.currentTarget) as { value?: string } | null;
            onChange(joinTime24(hour12, target?.value ?? minute, period));
          }}
        >
          {MINUTE_OPTIONS.map((min) => (
            <s-option key={min} value={min}>
              {min}
            </s-option>
          ))}
        </s-select>

        <s-select
          label="AM/PM"
          value={period}
          onChange={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
            const target = (event.target ?? event.currentTarget) as { value?: string } | null;
            onChange(joinTime24(hour12, minute, (target?.value as "AM" | "PM") ?? period));
          }}
        >
          <s-option value="AM">AM</s-option>
          <s-option value="PM">PM</s-option>
        </s-select>
      </s-grid>
    </s-stack>
  );
}

export default function CampaignEditor() {
  const {
    campaign,
    conditionsTree,
    reward: loadedReward,
    currencyCode,
    shopTimezone,
    productRefs: initialProductRefs,
    collectionRefs: initialCollectionRefs,
    markets,
    allCountries,
    loadNotice,
    planFeatures,
  } = useLoaderData<typeof loader>();
  const hasFeature = (feature: string) => (planFeatures as readonly string[]).includes(feature);
  // Scheduling is anchored to the merchant's own device/browser timezone,
  // not the shop's configured one — shopTimezone here is only the
  // SSR-safe placeholder used until this resolves client-side.
  const timezone = useDeviceTimezone(shopTimezone);
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const location = useLocation();
  const submit = useSubmit();
  const shopify = useAppBridge();

  const activeTab = useMemo<Tab>(() => {
    const requested = new URLSearchParams(location.search).get("tab");
    return (TABS as readonly string[]).includes(requested ?? "") ? (requested as Tab) : "general";
  }, [location.search]);

  const [name, setName] = useState(campaign.name);
  const [discountCode, setDiscountCode] = useState(campaign.discountCode ?? "");
  const initialConditions = useMemo<EditableGroup>(
    () => (toEditableTree(conditionsTree) as EditableGroup) ?? editableEmptyGroup(),
    [conditionsTree],
  );
  const [conditions, setConditions] = useState<EditableGroup>(initialConditions);
  const [reward, setReward] = useState<RewardConfig>(loadedReward);
  // The dirty check below can't just re-compare against the loader's
  // `loadedReward` after a successful save: that value round-trips
  // through normalizeRewardConfig(campaign.rewardJson) on the server,
  // which can rebuild the object with different key ordering than the
  // one built up client-side through this editor's own patches — same
  // data, different JSON.stringify output, so the Save button never
  // stopped looking dirty. Tracking the exact object that was last
  // successfully saved sidesteps that entirely.
  const [savedReward, setSavedReward] = useState<RewardConfig>(loadedReward);
  const savingRewardRef = useRef<RewardConfig | null>(null);
  const [startMode, setStartMode] = useState<"NOW" | "SCHEDULED">(campaign.scheduleStartAt ? "SCHEDULED" : "NOW");
  const [hasEndDate, setHasEndDate] = useState(Boolean(campaign.scheduleEndAt));
  const [startsAtDate, setStartsAtDate] = useState(datePartOf(campaign.scheduleStartAt, timezone));
  const [startsAtTime, setStartsAtTime] = useState(timePartOf(campaign.scheduleStartAt, "00:00", timezone));
  const [endsAtDate, setEndsAtDate] = useState(datePartOf(campaign.scheduleEndAt, timezone));
  const [endsAtTime, setEndsAtTime] = useState(timePartOf(campaign.scheduleEndAt, "23:30", timezone));
  // The fields above were seeded with the SSR-placeholder timezone; once
  // useDeviceTimezone resolves the real device zone, re-derive them from
  // the original stored UTC values so the displayed wall-clock time is
  // correct for THIS device — not just whatever happened to render first.
  const hasAppliedDeviceTimezone = useRef(false);
  useEffect(() => {
    if (hasAppliedDeviceTimezone.current || timezone === shopTimezone) return;
    hasAppliedDeviceTimezone.current = true;
    setStartsAtDate(datePartOf(campaign.scheduleStartAt, timezone));
    setStartsAtTime(timePartOf(campaign.scheduleStartAt, "00:00", timezone));
    setEndsAtDate(datePartOf(campaign.scheduleEndAt, timezone));
    setEndsAtTime(timePartOf(campaign.scheduleEndAt, "23:30", timezone));
  }, [timezone, shopTimezone, campaign.scheduleStartAt, campaign.scheduleEndAt]);
  const [priority, setPriority] = useState(campaign.priority);
  const [isExclusive, setIsExclusive] = useState(campaign.isExclusive);
  const initialUsageLimitTotal = campaign.usageLimitTotal !== null ? String(campaign.usageLimitTotal) : "";
  const initialUsageLimitPerCustomer = campaign.usageLimitPerCustomer !== null ? String(campaign.usageLimitPerCustomer) : "";
  const [usageLimitTotal, setUsageLimitTotal] = useState(initialUsageLimitTotal);
  const [usageLimitPerCustomer, setUsageLimitPerCustomer] = useState(initialUsageLimitPerCustomer);

  // Lifted here (not into ProductsEditor's own state) because each tab
  // unmounts whenever the merchant switches away from it — a cache
  // kept inside the tab component itself would reset to these
  // loader-provided titles on every visit, silently discarding an
  // unsaved resourcePicker selection. See ProductsEditor.tsx.
  const [productRefs, setProductRefs] = useState<HydratedResourceRef[]>(initialProductRefs);
  const [collectionRefs, setCollectionRefs] = useState<HydratedResourceRef[]>(initialCollectionRefs);

  const audienceLeaves = leavesOf(findManagedGroup(conditions, AUDIENCE_GROUP_ID));
  const productsLeaves = leavesOf(findManagedGroup(conditions, PRODUCTS_GROUP_ID));
  const marketsLeaves = leavesOf(findManagedGroup(conditions, MARKETS_GROUP_ID));

  const isGeneralDirty = name !== campaign.name || discountCode !== (campaign.discountCode ?? "");
  const isRewardDirty = JSON.stringify(reward) !== JSON.stringify(savedReward);
  const effectiveStartsAt = startMode === "SCHEDULED" ? combineDateTime(startsAtDate, startsAtTime, timezone) : "";
  const effectiveEndsAt = hasEndDate ? combineDateTime(endsAtDate, endsAtTime, timezone) : "";
  const isScheduleDirty = effectiveStartsAt !== campaign.scheduleStartAt || effectiveEndsAt !== campaign.scheduleEndAt;
  const isStackingDirty =
    priority !== campaign.priority ||
    isExclusive !== campaign.isExclusive ||
    usageLimitTotal !== initialUsageLimitTotal ||
    usageLimitPerCustomer !== initialUsageLimitPerCustomer;
  // Republish must respect unsaved edits on whatever tab is open right
  // now — pushing to Shopify while there's a pending, un-Saved change
  // sitting in a form field would silently drop it (Republish only
  // ever sends what's already been Saved to the database).
  const hasAnyUnsavedTabEdits = isGeneralDirty || isRewardDirty || isScheduleDirty || isStackingDirty;

  // Mirrors product-options's OptionSetBuilder convention: a redirect
  // carries "?notice=..." for the loader to translate, an in-place
  // action returns {notice} or {error} directly — both surface as a
  // toast, never a banner.
  useEffect(() => {
    if (loadNotice) shopify.toast.show(loadNotice, { duration: 2400 });
  }, [loadNotice, shopify]);

  useEffect(() => {
    if (!actionData) return;
    if (actionData.error) {
      shopify.toast.show(actionData.error, { isError: true });
    } else if (actionData.notice) {
      shopify.toast.show(actionData.notice, { duration: 2400 });
      if (savingRewardRef.current) {
        setSavedReward(savingRewardRef.current);
        savingRewardRef.current = null;
      }
    }
  }, [actionData, shopify]);

  const pendingAction = navigation.state !== "idle" ? navigation.formData?.get("_action") : null;
  const isSavingGeneral = pendingAction === "saveGeneral";
  const isSavingConditions = pendingAction === "saveConditions";
  const isSavingReward = pendingAction === "saveReward";
  const isSavingSchedule = pendingAction === "saveSchedule";
  const isSavingStacking = pendingAction === "saveStacking";
  const isPublishing = pendingAction === "publish" || pendingAction === "resume";
  const isPausing = pendingAction === "pause";
  const isUnpublishing = pendingAction === "unpublish";
  const isExpiring = pendingAction === "expire";
  const isDuplicating = pendingAction === "duplicate";
  const isDeleting = pendingAction === "delete";
  const isRunningHeaderAction = isPausing || isUnpublishing || isExpiring || isDuplicating || isDeleting;

  // None of Conditions/Customers/Products/Markets have their own Save
  // button — every change there is already one deliberate, atomic
  // action (confirmed via a popup, a checkbox toggle, or a resource
  // picker), so it persists immediately instead of requiring a second
  // confirming click that a stale dirty-check could get wrong.
  const persistConditions = (next: EditableGroup, message?: string) => {
    setConditions(next);
    const data = new FormData();
    data.set("_action", "saveConditions");
    data.set("conditionsJson", JSON.stringify(toConditionTree(next)));
    if (message) data.set("notice", message);
    submit(data, { method: "post" });
  };

  const saveReward = () => {
    savingRewardRef.current = reward;
    const data = new FormData();
    data.set("_action", "saveReward");
    data.set("rewardJson", JSON.stringify(reward));
    submit(data, { method: "post" });
  };

  const publish = () => {
    const data = new FormData();
    // A Paused campaign that already has a live Shopify Discount node
    // needs the "activate" mutation (resume) to actually flip it back
    // on — re-running publish's update path would push field changes
    // without ever touching Shopify's own enabled/disabled state (see
    // resumeCampaign's own comment in discount-publish.server.ts).
    data.set("_action", campaign.status === "PAUSED" && campaign.shopifyDiscountId ? "resume" : "publish");
    submit(data, { method: "post" });
  };

  const runHeaderAction = (action: "pause" | "unpublish" | "expire" | "duplicate" | "delete") => {
    const data = new FormData();
    data.set("_action", action);
    submit(data, { method: "post" });
  };

  return (
    <s-page heading={campaign.name}>
      <s-link slot="breadcrumb-actions" href="/app/campaigns">
        Campaigns
      </s-link>

      <s-badge slot="accessory" tone={statusBadgeTone(displayStatus(campaign))}>
        {`${campaign.kind} · ${displayStatus(campaign)}`}
      </s-badge>

      {campaign.status !== "ACTIVE" &&
        (campaign.status !== "PAUSED" && !hasAnyReward(loadedReward) ? (
          <s-button slot="primary-action" tone="critical" href={`/app/campaigns/${campaign.id}?tab=reward`}>
            Needs attention
          </s-button>
        ) : (
          <s-button slot="primary-action" variant="primary" onClick={publish} loading={isPublishing} disabled={isPublishing}>
            {campaign.status === "PAUSED" ? "Resume" : "Publish"}
          </s-button>
        ))}

      {campaign.status === "ACTIVE" &&
        (campaign.hasUnpublishedChanges ? (
          <s-button
            slot="primary-action"
            variant="primary"
            onClick={publish}
            loading={isPublishing}
            disabled={isPublishing || hasAnyUnsavedTabEdits}
            accessibilityLabel={
              hasAnyUnsavedTabEdits ? "Save your pending changes on this tab before republishing" : "Push your saved changes live to Shopify"
            }
          >
            Republish
          </s-button>
        ) : (
          // Nothing to push — a disabled "Published" button instead of an
          // empty slot, so it still reads as "this campaign is live and
          // in sync" at a glance, matching Republish's own visible spot.
          <s-button slot="primary-action" variant="primary" disabled accessibilityLabel="Already live — no changes to push">
            Published
          </s-button>
        ))}

      <s-button
        slot="secondary-actions"
        variant="secondary"
        icon="menu-horizontal"
        commandFor="campaign-header-actions-menu"
        loading={isRunningHeaderAction}
        disabled={isRunningHeaderAction}
      >
        More actions
      </s-button>

      <s-menu id="campaign-header-actions-menu" accessibilityLabel={`More actions for ${campaign.name}`}>
        {campaign.status === "ACTIVE" && (
          <s-button icon="pause-circle" loading={isPausing} disabled={isRunningHeaderAction} onClick={() => runHeaderAction("pause")}>
            Pause
          </s-button>
        )}

        {(campaign.status === "ACTIVE" || campaign.status === "PAUSED") && (
          <>
            <s-button icon="undo" loading={isUnpublishing} disabled={isRunningHeaderAction} onClick={() => runHeaderAction("unpublish")}>
              Move to Draft
            </s-button>
            <s-button icon="archive" loading={isExpiring} disabled={isRunningHeaderAction} onClick={() => runHeaderAction("expire")}>
              Expire
            </s-button>
          </>
        )}

        <s-button icon="duplicate" loading={isDuplicating} disabled={isRunningHeaderAction} onClick={() => runHeaderAction("duplicate")}>
          Duplicate
        </s-button>

        <s-button
          icon="delete"
          tone="critical"
          disabled={isRunningHeaderAction}
          commandFor="campaign-delete-modal"
          command="--show"
        >
          Delete
        </s-button>
      </s-menu>

      <s-modal id="campaign-delete-modal" heading={`Delete "${campaign.name}"?`}>
        <s-paragraph>
          This permanently deletes the campaign and removes its discount from Shopify. This can&apos;t be undone.
        </s-paragraph>

        <s-button slot="secondary-actions" commandFor="campaign-delete-modal" command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          tone="critical"
          variant="primary"
          loading={isDeleting}
          onClick={() => {
            hideOverlay("campaign-delete-modal");
            runHeaderAction("delete");
          }}
        >
          Delete campaign
        </s-button>
      </s-modal>

      <s-section>
        <s-stack direction="inline" gap="small">
          {TABS.map((tab) => (
            <s-button
              key={tab}
              variant={activeTab === tab ? "primary" : "secondary"}
              href={`/app/campaigns/${campaign.id}?tab=${tab}`}
            >
              {TAB_LABELS[tab]}
            </s-button>
          ))}
        </s-stack>
      </s-section>

      {activeTab === "general" && (
        <s-section heading="General">
          <Form method="post">
            <input type="hidden" name="_action" value="saveGeneral" />
            <s-stack direction="block" gap="base">
              <s-text-field
                label="Internal name"
                name="name"
                value={name}
                onInput={(event: { target: EventTarget | null }) => {
                  const target = event.target as { value?: string } | null;
                  setName(target?.value ?? "");
                }}
              />

              {campaign.kind === "CODE" && (
                <s-text-field
                  label="Discount code"
                  name="discountCode"
                  value={discountCode}
                  onInput={(event: { target: EventTarget | null }) => {
                    const target = event.target as { value?: string } | null;
                    setDiscountCode(target?.value ?? "");
                  }}
                />
              )}

              <s-button variant="primary" type="submit" loading={isSavingGeneral} disabled={isSavingGeneral || !isGeneralDirty}>
                Save
              </s-button>
            </s-stack>
          </Form>
        </s-section>
      )}

      {activeTab === "conditions" && (
        <s-section heading="Conditions">
          <ConditionsEditor value={conditions} onChange={persistConditions} saving={isSavingConditions} />
        </s-section>
      )}

      {activeTab === "audience" && (
        <s-section heading="Customers">
          {hasFeature("CUSTOMER_TARGETING") ? (
            <AudienceEditor
              leaves={audienceLeaves}
              onChange={(next) => persistConditions(setManagedLeaves(conditions, AUDIENCE_GROUP_ID, next), "Customers updated.")}
              currencyCode={currencyCode}
            />
          ) : (
            <UpgradePrompt feature="Customer targeting" />
          )}
        </s-section>
      )}

      {activeTab === "products" && (
        <s-section heading="Products">
          {hasFeature("PRODUCT_TARGETING") ? (
            <ProductsEditor
              leaves={productsLeaves}
              onChange={(next) => persistConditions(setManagedLeaves(conditions, PRODUCTS_GROUP_ID, next), "Products updated.")}
              productRefs={productRefs}
              onProductRefsChange={setProductRefs}
              collectionRefs={collectionRefs}
              onCollectionRefsChange={setCollectionRefs}
            />
          ) : (
            <UpgradePrompt feature="Product targeting" />
          )}
        </s-section>
      )}

      {activeTab === "markets" && (
        <s-section heading="Markets">
          {hasFeature("MARKET_TARGETING") ? (
            <MarketsEditor
              leaves={marketsLeaves}
              onChange={(next) => persistConditions(setManagedLeaves(conditions, MARKETS_GROUP_ID, next), "Markets updated.")}
              markets={markets}
              allCountries={allCountries}
            />
          ) : (
            <UpgradePrompt feature="Market targeting" />
          )}
        </s-section>
      )}

      {activeTab === "reward" && (
        <s-section heading="Discount">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Enable one or more discount types. All enabled discounts apply
              together when this campaign&apos;s conditions match.
            </s-paragraph>

            <RewardEditor
              value={reward}
              onChange={setReward}
              currencyCode={currencyCode}
              productRefs={productRefs}
              onProductRefsChange={setProductRefs}
              campaignKind={campaign.kind as "CODE" | "AUTOMATIC"}
              hasTiers={hasFeature("TIERS")}
              hasFreeGiftBogo={hasFeature("FREE_GIFT_BOGO")}
              hasMinimumRequirement={hasFeature("MINIMUM_REQUIREMENT")}
            />

            <s-button variant="primary" onClick={saveReward} loading={isSavingReward} disabled={isSavingReward || !isRewardDirty}>
              Save discount
            </s-button>
          </s-stack>
        </s-section>
      )}

      {activeTab === "schedule" && (
        <s-section heading="Schedule">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Enforced by Shopify itself — the discount won&apos;t activate or will expire automatically outside this window.
            </s-paragraph>
            <s-text color="subdued">Dates and times below are in your current device&apos;s timezone ({timezone}).</s-text>

            <s-choice-list
              label="Start"
              name="startMode"
              values={[startMode]}
              onChange={(event: { currentTarget: { values?: string[] } }) => {
                const next = event.currentTarget.values?.[0];
                if (next === "NOW" || next === "SCHEDULED") setStartMode(next);
              }}
            >
              <s-choice value="NOW">Start now</s-choice>
              <s-choice value="SCHEDULED">Start on a specific date</s-choice>
            </s-choice-list>

            <s-checkbox
              label="Set an end date"
              checked={hasEndDate}
              onChange={(event: { target: EventTarget | null }) => {
                const target = event.target as { checked?: boolean } | null;
                setHasEndDate(Boolean(target?.checked));
              }}
            />

            {(startMode === "SCHEDULED" || hasEndDate) && (
              <s-grid gridTemplateColumns={`repeat(${2 * ((startMode === "SCHEDULED" ? 1 : 0) + (hasEndDate ? 1 : 0))}, minmax(140px, 1fr))`} gap="base" alignItems="end">
                {startMode === "SCHEDULED" && (
                  <>
                    <s-date-field
                      label="Start date"
                      value={startsAtDate}
                      onInput={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
                        const target = (event.target ?? event.currentTarget) as { value?: string } | null;
                        setStartsAtDate(target?.value ?? "");
                      }}
                      onChange={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
                        const target = (event.target ?? event.currentTarget) as { value?: string } | null;
                        setStartsAtDate(target?.value ?? "");
                      }}
                    />

                    <TimeFields label="Start time" value={startsAtTime} onChange={setStartsAtTime} />
                  </>
                )}

                {hasEndDate && (
                  <>
                    <s-date-field
                      label="End date"
                      value={endsAtDate}
                      onInput={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
                        const target = (event.target ?? event.currentTarget) as { value?: string } | null;
                        setEndsAtDate(target?.value ?? "");
                      }}
                      onChange={(event: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
                        const target = (event.target ?? event.currentTarget) as { value?: string } | null;
                        setEndsAtDate(target?.value ?? "");
                      }}
                    />

                    <TimeFields label="End time" value={endsAtTime} onChange={setEndsAtTime} />
                  </>
                )}
              </s-grid>
            )}

            {campaign.status === "ACTIVE" && (
              <s-text tone="neutral">
                This campaign is already live — Publish again after saving to push schedule changes to checkout.
              </s-text>
            )}

            <s-button
              variant="primary"
              onClick={() => {
                const data = new FormData();
                data.set("_action", "saveSchedule");
                data.set("startsAt", effectiveStartsAt);
                data.set("endsAt", effectiveEndsAt);
                submit(data, { method: "post" });
              }}
              loading={isSavingSchedule}
              disabled={isSavingSchedule || !isScheduleDirty}
            >
              Save schedule
            </s-button>
          </s-stack>
        </s-section>
      )}

      {activeTab === "stacking" && (
        <s-section heading="Stacking">
          <s-stack direction="block" gap="base">
            <s-paragraph>How this campaign behaves when it overlaps with another active campaign.</s-paragraph>

            {!hasFeature("STACKING") && (
              <s-banner tone="info">
                Priority, exclusivity, and usage limits need an upgrade — this campaign uses your shop&apos;s default
                conflict behavior until then.{" "}
                <s-link href="/app/plans">View plans</s-link>
              </s-banner>
            )}

            <s-number-field
              label={hasFeature("STACKING") ? "Priority" : "Priority (upgrade required)"}
              value={String(priority)}
              disabled={!hasFeature("STACKING")}
              onInput={(event: { target: EventTarget | null }) => {
                const target = event.target as { value?: string } | null;
                setPriority(Number(target?.value ?? "0") || 0);
              }}
              details="Higher number wins ties."
            />

            <s-checkbox
              label={hasFeature("STACKING") ? "Exclusive (no other campaign applies)" : "Exclusive (upgrade required)"}
              checked={isExclusive}
              disabled={!hasFeature("STACKING")}
              onChange={(event: { target: EventTarget | null }) => {
                const target = event.target as { checked?: boolean } | null;
                setIsExclusive(Boolean(target?.checked));
              }}
            />

            <s-heading>Usage limits</s-heading>
            <s-paragraph>
              Leave blank for unlimited.{" "}
              {campaign.usageCount > 0 && (
                <>Used {campaign.usageCount} time{campaign.usageCount === 1 ? "" : "s"} so far.</>
              )}
            </s-paragraph>

            <s-number-field
              label={hasFeature("STACKING") ? "Max total uses" : "Max total uses (upgrade required)"}
              min={1}
              value={usageLimitTotal}
              disabled={!hasFeature("STACKING")}
              onInput={(event: { target: EventTarget | null }) => {
                const target = event.target as { value?: string } | null;
                setUsageLimitTotal(target?.value ?? "");
              }}
            />

            <s-number-field
              label={hasFeature("STACKING") ? "Max uses per customer" : "Max uses per customer (upgrade required)"}
              min={1}
              value={usageLimitPerCustomer}
              disabled={!hasFeature("STACKING")}
              onInput={(event: { target: EventTarget | null }) => {
                const target = event.target as { value?: string } | null;
                setUsageLimitPerCustomer(target?.value ?? "");
              }}
            />

            <s-button
              variant="primary"
              onClick={() => {
                const data = new FormData();
                data.set("_action", "saveStacking");
                data.set("priority", String(priority));
                data.set("isExclusive", isExclusive ? "true" : "false");
                data.set("usageLimitTotal", usageLimitTotal);
                data.set("usageLimitPerCustomer", usageLimitPerCustomer);
                submit(data, { method: "post" });
              }}
              loading={isSavingStacking}
              disabled={isSavingStacking || !isStackingDirty}
            >
              Save stacking settings
            </s-button>
          </s-stack>
        </s-section>
      )}

    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

/**
 * Publishes a Campaign to Shopify: compiles its conditions/reward (see
 * campaign-compiler.server.ts), then creates or updates ITS OWN
 * Discount node pointing at the one shared "winslet-discounts"
 * Function — never a new Function per campaign (Shopify caps active
 * Functions per store; wholesale-registration's own architecture note
 * on this applies here too). Every campaign gets its own Discount node
 * because that's the only way each one can carry its own compiled
 * config in its own metafield and be individually paused/deleted.
 *
 * Two things here are correct-by-strong-precedent but NOT yet verified
 * against a live schema (shopify-dev-mcp was unavailable while this was
 * written, and there is no deployed app/Partner Dashboard connection to
 * introspect against) — verify both before the first real deploy:
 *   1. The exact return field name on DiscountAutomaticAppCreatePayload
 *      /DiscountCodeAppCreatePayload for the new Discount node's GID
 *      (assumed here to be `discountId`).
 *   2. DiscountCodeAppInput's field for the code string (assumed here
 *      to be `code: String!`, mirroring DiscountAutomaticAppInput's
 *      shape plus this one field).
 *
 * Metafield namespace is "$app", not "$app:winslet-discounts" — using
 * the extension-qualified form here silently reads back null in the
 * Function (a real bug wholesale-registration shipped and documented;
 * see its pricing-compiler.server.ts).
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { Prisma, type Campaign } from "@prisma/client";
import db from "../db.server";
import { compileCampaignForPublish } from "./campaign-compiler.server";
import { hasAnyReward, type RewardConfig } from "../lib/reward-types";

const FUNCTION_HANDLE = "winslet-discounts";
const METAFIELD_NAMESPACE = "$app";
const METAFIELD_KEY = "function-configuration";

export interface PublishResult {
  ok: boolean;
  message?: string;
}

function discountClassesFor(reward: RewardConfig): string[] {
  const classes: string[] = [];
  if (reward.product) classes.push("PRODUCT");
  if (reward.order) classes.push("ORDER");
  if (reward.shipping) classes.push("SHIPPING");
  return classes;
}

/**
 * Every Winslet campaign combines with every other active discount by
 * default (Shopify's own combinesWith defaults to false per class).
 * Without this, Shopify's platform-level rules would silently drop all
 * but one matching discount per class BEFORE the Smart Conflict Engine
 * (M10) ever got a chance to decide who should actually win — the
 * whole point of that engine is to make an informed choice Shopify's
 * own blunt yes/no toggle can't express, which requires every matching
 * campaign to actually reach its Function invocation.
 *
 * Shopify rejects combinesWith.<X>: true for any class the discount
 * itself belongs to ("... is not supported with these combines_with
 * settings") — a discount can't combine with its own class — so each
 * flag is only true when discountClasses doesn't already include it.
 */
function combinesWithFor(discountClasses: string[]) {
  return {
    orderDiscounts: !discountClasses.includes("ORDER"),
    productDiscounts: !discountClasses.includes("PRODUCT"),
    shippingDiscounts: !discountClasses.includes("SHIPPING"),
  };
}

interface UserError {
  field?: string[] | null;
  message: string;
}

function firstErrorMessage(userErrors: UserError[]): string {
  return userErrors.map((error) => error.message).join(" ") || "Shopify rejected this campaign.";
}

/** A delete is idempotent: if Shopify already has no such discount (deleted manually, or a code discount Shopify garbage-collected after expiry), the desired end state already holds — that's success, not failure. Without this, a campaign whose discount vanished on Shopify's side could never be deleted through the app again. */
function isAlreadyGoneError(userErrors: UserError[]): boolean {
  return userErrors.some((error) => /does not exist|not found/i.test(error.message));
}

/**
 * Scheduling (M9) is delegated entirely to Shopify's own discount
 * startsAt/endsAt — Shopify won't even consider the discount outside
 * that window, so the Function itself needs no schedule-awareness.
 *
 * Shopify's discountAutomaticAppCreate/discountCodeAppCreate reject a
 * missing startsAt outright ("Starts at can't be blank.") — there's no
 * existing discount for it to inherit a start time from yet. The
 * Schedule tab's "Start now" mode (the default) deliberately leaves
 * `campaign.scheduleStartAt` unset rather than writing the moment the
 * merchant happened to open that tab, so CREATE defaults it to the
 * actual moment of publish instead. UPDATE omits it when unset,
 * leaving Shopify's already-stored startsAt alone — sending "now"
 * on every republish would keep pushing a live discount's start time
 * forward.
 */
function scheduleFields(campaign: Campaign, isCreate: boolean): { startsAt?: string; endsAt?: string } {
  // A never-published campaign whose configured start date has already
  // slipped into the past (the merchant picked a date, then didn't
  // publish until after it passed) shouldn't launch backdated to that
  // stale moment — it should just go live now, the same as if no start
  // date had been set at all. Only on CREATE: an already-live campaign's
  // startsAt is always in the past by the time it's edited again, and
  // that case must keep omitting startsAt on UPDATE so republishing
  // never pushes a live discount's start time forward (see below).
  const configuredStartHasPassed = isCreate && campaign.scheduleStartAt !== null && campaign.scheduleStartAt.getTime() <= Date.now();
  const startsAt =
    campaign.scheduleStartAt && !configuredStartHasPassed ? campaign.scheduleStartAt.toISOString() : isCreate ? new Date().toISOString() : undefined;

  return {
    ...(startsAt ? { startsAt } : {}),
    ...(campaign.scheduleEndAt ? { endsAt: campaign.scheduleEndAt.toISOString() } : {}),
  };
}

async function publishAutomatic(admin: AdminApiContext, campaign: Campaign, discountClasses: string[], metafieldValue: string): Promise<PublishResult> {
  const metafields = [{ namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY, type: "json", value: metafieldValue }];
  const schedule = scheduleFields(campaign, !campaign.shopifyDiscountId);

  if (campaign.shopifyDiscountId) {
    const response = await admin.graphql(
      `#graphql
        mutation WinsletDiscountAutomaticUpdate($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
          discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
            userErrors { field message }
          }
        }`,
      {
        variables: {
          id: campaign.shopifyDiscountId,
          automaticAppDiscount: { title: campaign.name, discountClasses, metafields, combinesWith: combinesWithFor(discountClasses), ...schedule },
        },
      },
    );

    const payload = (await response.json()) as { data?: { discountAutomaticAppUpdate?: { userErrors?: UserError[] } } };
    const userErrors = payload.data?.discountAutomaticAppUpdate?.userErrors ?? [];
    return userErrors.length ? { ok: false, message: firstErrorMessage(userErrors) } : { ok: true };
  }

  const response = await admin.graphql(
    `#graphql
      mutation WinsletDiscountAutomaticCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        automaticAppDiscount: { title: campaign.name, functionHandle: FUNCTION_HANDLE, discountClasses, metafields, combinesWith: combinesWithFor(discountClasses), ...schedule },
      },
    },
  );

  const payload = (await response.json()) as {
    data?: {
      discountAutomaticAppCreate?: {
        automaticAppDiscount?: { discountId?: string } | null;
        userErrors?: UserError[];
      };
    };
  };

  const userErrors = payload.data?.discountAutomaticAppCreate?.userErrors ?? [];
  if (userErrors.length) return { ok: false, message: firstErrorMessage(userErrors) };

  const discountId = payload.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId;
  if (discountId) {
    await db.campaign.update({ where: { id: campaign.id }, data: { shopifyDiscountId: discountId } });
  }

  return { ok: true };
}

async function publishCode(admin: AdminApiContext, campaign: Campaign, discountClasses: string[], metafieldValue: string): Promise<PublishResult> {
  const metafields = [{ namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY, type: "json", value: metafieldValue }];
  const code = campaign.discountCode?.trim();
  if (!code) return { ok: false, message: "This campaign is missing its discount code." };
  const schedule = scheduleFields(campaign, !campaign.shopifyDiscountId);

  if (campaign.shopifyDiscountId) {
    const response = await admin.graphql(
      `#graphql
        mutation WinsletDiscountCodeUpdate($id: ID!, $codeAppDiscount: DiscountCodeAppInput!) {
          discountCodeAppUpdate(id: $id, codeAppDiscount: $codeAppDiscount) {
            userErrors { field message }
          }
        }`,
      { variables: { id: campaign.shopifyDiscountId, codeAppDiscount: { title: campaign.name, code, discountClasses, metafields, combinesWith: combinesWithFor(discountClasses), ...schedule } } },
    );

    const payload = (await response.json()) as { data?: { discountCodeAppUpdate?: { userErrors?: UserError[] } } };
    const userErrors = payload.data?.discountCodeAppUpdate?.userErrors ?? [];
    return userErrors.length ? { ok: false, message: firstErrorMessage(userErrors) } : { ok: true };
  }

  const response = await admin.graphql(
    `#graphql
      mutation WinsletDiscountCodeCreate($codeAppDiscount: DiscountCodeAppInput!) {
        discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
          codeAppDiscount { discountId }
          userErrors { field message }
        }
      }`,
    { variables: { codeAppDiscount: { title: campaign.name, code, functionHandle: FUNCTION_HANDLE, discountClasses, metafields, combinesWith: combinesWithFor(discountClasses), ...schedule } } },
  );

  const payload = (await response.json()) as {
    data?: {
      discountCodeAppCreate?: { codeAppDiscount?: { discountId?: string } | null; userErrors?: UserError[] };
    };
  };

  const userErrors = payload.data?.discountCodeAppCreate?.userErrors ?? [];
  if (userErrors.length) return { ok: false, message: firstErrorMessage(userErrors) };

  const discountId = payload.data?.discountCodeAppCreate?.codeAppDiscount?.discountId;
  if (discountId) {
    await db.campaign.update({ where: { id: campaign.id }, data: { shopifyDiscountId: discountId } });
  }

  return { ok: true };
}

type LifecycleAction = "activate" | "deactivate" | "delete";

const LIFECYCLE_MUTATION: Record<"AUTOMATIC" | "CODE", Record<LifecycleAction, { field: string; document: string }>> = {
  AUTOMATIC: {
    activate: {
      field: "discountAutomaticActivate",
      document: `#graphql
        mutation WinsletDiscountAutomaticActivate($id: ID!) {
          discountAutomaticActivate(id: $id) {
            userErrors { field message }
          }
        }`,
    },
    deactivate: {
      field: "discountAutomaticDeactivate",
      document: `#graphql
        mutation WinsletDiscountAutomaticDeactivate($id: ID!) {
          discountAutomaticDeactivate(id: $id) {
            userErrors { field message }
          }
        }`,
    },
    delete: {
      field: "discountAutomaticDelete",
      document: `#graphql
        mutation WinsletDiscountAutomaticDelete($id: ID!) {
          discountAutomaticDelete(id: $id) {
            userErrors { field message }
          }
        }`,
    },
  },
  CODE: {
    activate: {
      field: "discountCodeActivate",
      document: `#graphql
        mutation WinsletDiscountCodeActivate($id: ID!) {
          discountCodeActivate(id: $id) {
            userErrors { field message }
          }
        }`,
    },
    deactivate: {
      field: "discountCodeDeactivate",
      document: `#graphql
        mutation WinsletDiscountCodeDeactivate($id: ID!) {
          discountCodeDeactivate(id: $id) {
            userErrors { field message }
          }
        }`,
    },
    delete: {
      field: "discountCodeDelete",
      document: `#graphql
        mutation WinsletDiscountCodeDelete($id: ID!) {
          discountCodeDelete(id: $id) {
            userErrors { field message }
          }
        }`,
    },
  },
};

async function runLifecycleMutation(admin: AdminApiContext, campaign: Campaign, action: LifecycleAction): Promise<PublishResult> {
  if (!campaign.shopifyDiscountId) return { ok: true };

  const kind = campaign.kind === "CODE" ? "CODE" : "AUTOMATIC";
  const { field, document } = LIFECYCLE_MUTATION[kind][action];

  const response = await admin.graphql(document, { variables: { id: campaign.shopifyDiscountId } });
  const payload = (await response.json()) as { data?: Record<string, { userErrors?: UserError[] } | undefined> };
  const userErrors = payload.data?.[field]?.userErrors ?? [];
  if (!userErrors.length) return { ok: true };
  if (action === "delete" && isAlreadyGoneError(userErrors)) return { ok: true };

  return { ok: false, message: firstErrorMessage(userErrors) };
}

/** Pauses a published campaign on Shopify's side without losing its Discount node — resumeCampaign reactivates the same node rather than republishing from scratch. */
export async function pauseCampaign(admin: AdminApiContext, campaign: Campaign): Promise<PublishResult> {
  const result = await runLifecycleMutation(admin, campaign, "deactivate");
  if (!result.ok) return result;

  await db.campaign.update({ where: { id: campaign.id }, data: { status: "PAUSED" } });
  return { ok: true };
}

/** Unlike pause (meant to be temporary), archive marks a campaign as permanently done — same Shopify-side deactivation, but lands in ARCHIVED rather than PAUSED so it stops showing up as something to resume. */
export async function archiveCampaign(admin: AdminApiContext, campaign: Campaign): Promise<PublishResult> {
  const result = await runLifecycleMutation(admin, campaign, "deactivate");
  if (!result.ok) return result;

  await db.campaign.update({ where: { id: campaign.id }, data: { status: "ARCHIVED" } });
  return { ok: true };
}

/**
 * Pulls a published campaign back down to Draft for editing — deletes
 * its Shopify Discount node entirely (not just deactivates it) and
 * clears shopifyDiscountId/publishedAt/publishedSnapshotJson, so the
 * campaign returns to exactly the same "never touched Shopify" state
 * DRAFT means everywhere else in this app (the auto-publish scheduler,
 * the Scheduled badge, etc. all key off shopifyDiscountId being null).
 * The campaign's own configuration (conditions, reward) is left
 * untouched — but its schedule IS cleared, not just its live state:
 * scheduled-publish.server.ts auto-publishes any DRAFT campaign whose
 * scheduleStartAt has already passed, so leaving a stale past
 * startsAt in place would have the scheduler immediately re-publish
 * this campaign again within seconds of pulling it back to Draft —
 * exactly the opposite of what "Move to Draft" is for. The merchant
 * has to set a deliberate new date before this can go live again.
 */
export async function unpublishCampaign(admin: AdminApiContext, campaign: Campaign): Promise<PublishResult> {
  const result = await runLifecycleMutation(admin, campaign, "delete");
  if (!result.ok) return result;

  await db.campaign.update({
    where: { id: campaign.id },
    data: {
      status: "DRAFT",
      shopifyDiscountId: null,
      publishedSnapshotJson: Prisma.JsonNull,
      publishedAt: null,
      scheduleStartAt: null,
      scheduleEndAt: null,
    },
  });
  return { ok: true };
}

export async function resumeCampaign(admin: AdminApiContext, campaign: Campaign): Promise<PublishResult> {
  if (!campaign.shopifyDiscountId) return publishCampaign(admin, campaign);

  const result = await runLifecycleMutation(admin, campaign, "activate");
  if (!result.ok) return result;

  // Reactivating only flips Shopify's own enabled bit (see the lifecycle
  // mutation above) — it never re-pushes the compiled snapshot, so the
  // live content is exactly whatever publishedAt already says it is.
  // Re-pin updatedAt to that same instant instead of letting Prisma's
  // @updatedAt auto-bump it to "now", or hasUnpublishedChanges would
  // spuriously flag a Republish the moment this resume completes.
  await db.campaign.update({ where: { id: campaign.id }, data: { status: "ACTIVE", updatedAt: campaign.publishedAt ?? new Date() } });
  return { ok: true };
}

/** Deletes the campaign's Shopify Discount node (if it was ever published) then the campaign row itself — cascades to its versions/executions/analytics via schema.prisma's onDelete: Cascade relations. */
export async function deleteCampaignEverywhere(admin: AdminApiContext, campaign: Campaign): Promise<PublishResult> {
  const result = await runLifecycleMutation(admin, campaign, "delete");
  if (!result.ok) return result;

  await db.campaign.delete({ where: { id: campaign.id } });
  return { ok: true };
}

export async function publishCampaign(admin: AdminApiContext, campaign: Campaign): Promise<PublishResult> {
  const compiled = await compileCampaignForPublish(admin, campaign);

  if (!hasAnyReward(compiled.reward)) {
    return { ok: false, message: "Add a reward before activating this campaign." };
  }

  const discountClasses = discountClassesFor(compiled.reward);
  const metafieldValue = JSON.stringify(compiled);

  const result =
    campaign.kind === "CODE"
      ? await publishCode(admin, campaign, discountClasses, metafieldValue)
      : await publishAutomatic(admin, campaign, discountClasses, metafieldValue);

  if (result.ok) {
    // The SAME instant for both fields — @updatedAt otherwise
    // auto-stamps a few milliseconds after this literal `publishedAt`
    // was evaluated, leaving updatedAt permanently just past
    // publishedAt and hasUnpublishedChanges permanently (wrongly) true.
    const publishedAt = new Date();
    await db.campaign.update({
      where: { id: campaign.id },
      data: { status: "ACTIVE", publishedSnapshotJson: compiled as unknown as object, publishedAt, updatedAt: publishedAt },
    });
  }

  return result;
}

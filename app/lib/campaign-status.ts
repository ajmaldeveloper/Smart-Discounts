/**
 * Published to Shopify (status ACTIVE, a real Discount node exists)
 * but its own startsAt hasn't arrived yet — Shopify is holding it back
 * on its own, the same as it would for any native discount scheduled
 * for later. A merely-Draft campaign with a future date typed into its
 * Schedule tab does NOT count: nothing was ever sent to Shopify, so it
 * won't do anything on its own — it still needs an explicit Publish
 * click, same as any other Draft. Shared between the campaigns list
 * and the campaign editor's own header badge so both always agree on
 * when to show "Scheduled".
 */
export function isScheduledPending(campaign: { status: string; scheduleStartAt: string | null }): boolean {
  return Boolean(campaign.status === "ACTIVE" && campaign.scheduleStartAt && new Date(campaign.scheduleStartAt) > new Date());
}

export function displayStatus(campaign: { status: string; scheduleStartAt: string | null }): string {
  return hasFutureStart(campaign) ? "SCHEDULED" : campaign.status;
}

/**
 * A future start date is configured, whether or not the campaign has
 * actually been published yet — worth surfacing either way: on an
 * unpublished Draft it tells the merchant what will happen once they
 * hit Publish; on a published (Scheduled) campaign it's the moment
 * Shopify will actually flip it on. Separate from isScheduledPending
 * on purpose — the "Starts ..." hint and the "SCHEDULED" badge answer
 * different questions and shouldn't be tied to the same condition.
 */
export function hasFutureStart(campaign: { scheduleStartAt: string | null }): boolean {
  return Boolean(campaign.scheduleStartAt && new Date(campaign.scheduleStartAt) > new Date());
}

export function statusBadgeTone(status: string): "success" | "info" | "neutral" | "warning" {
  if (status === "ACTIVE") return "success";
  if (status === "DRAFT" || status === "SCHEDULED") return "info";
  if (status === "PAUSED") return "warning";
  return "neutral";
}

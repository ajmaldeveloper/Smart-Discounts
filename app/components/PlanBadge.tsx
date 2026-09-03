type BadgeTone = "neutral" | "info" | "success";

/** Free reads as a plain/neutral badge, not an achievement; paid tiers step up through info (Growth) to success (Pro) — mirrors the "Current"/"Recommended" tones already used on the Plans page. */
function getToneForPlanCode(planCode: string): BadgeTone {
  if (planCode === "PRO") return "success";
  if (planCode === "GROWTH") return "info";
  return "neutral";
}

export default function PlanBadge({ planName, planCode }: { planName: string; planCode: string }) {
  return <s-badge tone={getToneForPlanCode(planCode)}>{planName} plan</s-badge>;
}

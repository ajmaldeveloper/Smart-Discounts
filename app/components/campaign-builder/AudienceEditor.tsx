import { useState } from "react";

import type { EditableLeaf } from "../../lib/condition-tree-edit";
import { currencySymbol } from "../../lib/currency-display";

// Mirrors ConditionsEditor.tsx's convention: s-select fires onChange,
// s-text-field/s-number-field fire onInput, both read the same way.
type ControlEvent = { target: EventTarget | null; currentTarget: EventTarget | null };
function readValue(event: ControlEvent): string {
  const target = (event.target ?? event.currentTarget) as { value?: unknown } | null;
  return String(target?.value ?? "");
}
function readChecked(event: ControlEvent): boolean {
  const target = (event.target ?? event.currentTarget) as { checked?: unknown } | null;
  return Boolean(target?.checked);
}

type Scope = "EVERYONE" | "LOGGED_IN" | "GUEST" | "TAG";

interface Props {
  leaves: EditableLeaf[];
  onChange: (next: EditableLeaf[]) => void;
  currencyCode: string;
}

function leaf(field: string, operator: EditableLeaf["operator"], value: string): EditableLeaf {
  return { id: `managed:audience:${field}:${operator}`, type: "condition", field, operator, value };
}

/**
 * A friendlier face on the same customer.* condition fields the
 * generic Conditions tab already exposes (see condition-fields.ts) —
 * this tab writes into the same conditionsJson tree via a
 * "managed:audience" subgroup (see condition-tree-edit.ts's
 * findManagedGroup/setManagedLeaves), not a separate/unused storage
 * column, so it needs no changes anywhere else in the discount engine.
 *
 * Tag fields are plain comma-separated text bound directly to the
 * leaf's own raw string (same convention as ConditionsEditor's Value
 * field for in/not_in) rather than parsed into an array on every
 * keystroke — trimming/splitting happens once, at save time, in
 * condition-tree-edit.ts's textToValue. Reformatting the field's own
 * displayed value while the merchant is still typing (e.g. after a
 * trailing comma) would fight their cursor.
 *
 * "Show this campaign to" is a single 4-way scope: login-status and
 * tag-inclusion are mutually exclusive here (picking "Customers with
 * specific tags" clears any logged-in/guest restriction and vice
 * versa). Exceptions (exclude tags) stays independent of all four and
 * is only hidden for the TAG scope, since "only these tags" and
 * "exclude these other tags" would otherwise say two contradictory
 * things at once.
 */
export default function AudienceEditor({ leaves, onChange, currencyCode }: Props) {
  const currency = currencySymbol(currencyCode);
  const loggedInLeaf = leaves.find((l) => l.field === "customer.loggedIn");
  const includeTagLeaf = leaves.find((l) => l.field === "customer.tag" && l.operator === "in");
  const excludeTagLeaf = leaves.find((l) => l.field === "customer.tag" && l.operator === "not_in");
  const spendLeaf = leaves.find((l) => l.field === "customer.totalSpent");
  const orderCountLeaf = leaves.find((l) => l.field === "customer.orderCount");

  const scope: Scope = includeTagLeaf
    ? "TAG"
    : loggedInLeaf
      ? loggedInLeaf.value === "true"
        ? "LOGGED_IN"
        : "GUEST"
      : "EVERYONE";
  const includeTagsText = includeTagLeaf?.value ?? "";
  const excludeTagsText = excludeTagLeaf?.value ?? "";

  // Local-only reveal toggle (see ProductsEditor's matching comment),
  // seeded from whatever's already saved.
  const [showExceptions, setShowExceptions] = useState(() => Boolean(excludeTagLeaf));

  const rebuild = (patch: {
    scope?: Scope;
    includeTagsText?: string;
    excludeTagsText?: string;
    minSpend?: string;
    minOrders?: string;
  }) => {
    const nextScope = patch.scope ?? scope;
    const nextIncludeTagsText = nextScope === "TAG" ? (patch.includeTagsText ?? includeTagsText) : "";
    const nextExcludeTagsText = patch.excludeTagsText ?? excludeTagsText;
    const nextMinSpend = patch.minSpend ?? spendLeaf?.value ?? "";
    const nextMinOrders = patch.minOrders ?? orderCountLeaf?.value ?? "";

    const next: EditableLeaf[] = [];
    if (nextScope === "LOGGED_IN" || nextScope === "GUEST") {
      next.push(leaf("customer.loggedIn", "equals", nextScope === "LOGGED_IN" ? "true" : "false"));
    }
    // Pushed even when empty while TAG scope is selected — otherwise
    // choosing this scope with no tags typed yet leaves no trace once
    // saved, and the dropdown silently reverts to "Everyone" on the
    // next render because `scope` is derived from whether this leaf
    // exists at all, not from a separate "which option is selected"
    // flag.
    if (nextScope === "TAG" || nextIncludeTagsText.trim()) next.push(leaf("customer.tag", "in", nextIncludeTagsText));
    if (nextExcludeTagsText.trim()) next.push(leaf("customer.tag", "not_in", nextExcludeTagsText));
    if (nextMinSpend.trim()) next.push(leaf("customer.totalSpent", "greater_than_or_equal", nextMinSpend));
    if (nextMinOrders.trim()) next.push(leaf("customer.orderCount", "greater_than_or_equal", nextMinOrders));

    onChange(next);
  };

  return (
    <s-stack direction="block" gap="base">
      <s-paragraph>
        Restrict this campaign to a specific type of shopper. Leave everything blank to match any customer.
      </s-paragraph>

      <s-select
        label="Show this campaign to"
        value={scope}
        onChange={(event: ControlEvent) => rebuild({ scope: readValue(event) as Scope })}
      >
        <s-option value="EVERYONE">Everyone</s-option>
        <s-option value="LOGGED_IN">Logged-in customers only</s-option>
        <s-option value="GUEST">Guests only</s-option>
        <s-option value="TAG">Customers with specific tags</s-option>
      </s-select>

      {scope === "TAG" && (
        <s-text-field
          label="Customer tags"
          value={includeTagsText}
          placeholder="VIP, Wholesale"
          details="Comma-separated. Matches if the buyer carries any of these tags."
          onInput={(event: ControlEvent) => rebuild({ includeTagsText: readValue(event) })}
        />
      )}

      <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="small">
        <s-number-field
          label="Minimum lifetime spend (optional)"
          prefix={currency}
          min={0}
          value={spendLeaf?.value ?? ""}
          onInput={(event: ControlEvent) => rebuild({ minSpend: readValue(event) })}
        />
        <s-number-field
          label="Minimum past orders (optional)"
          min={0}
          value={orderCountLeaf?.value ?? ""}
          details="0 matches first-time customers too."
          onInput={(event: ControlEvent) => rebuild({ minOrders: readValue(event) })}
        />
      </s-grid>

      {scope !== "TAG" && (
        <s-stack direction="block" gap="small">
          <s-checkbox
            label="Exclude customers with specific tags"
            checked={showExceptions}
            onChange={(event: ControlEvent) => {
              const checked = readChecked(event);
              setShowExceptions(checked);
              if (!checked) rebuild({ excludeTagsText: "" });
            }}
          />

          {showExceptions && (
            <s-text-field
              label="Excluded tags"
              value={excludeTagsText}
              placeholder="Blocked"
              details="Comma-separated. Customers with any of these tags are excluded."
              onInput={(event: ControlEvent) => rebuild({ excludeTagsText: readValue(event) })}
            />
          )}
        </s-stack>
      )}
    </s-stack>
  );
}

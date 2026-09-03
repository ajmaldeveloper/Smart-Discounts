import { useState } from "react";

import type { EditableLeaf } from "../../lib/condition-tree-edit";
import { countryDisplayName, countryFlagEmoji } from "../../lib/country-display";
import MultiSelectPicker from "./MultiSelectPicker";

type ControlEvent = { target: EventTarget | null; currentTarget: EventTarget | null };
function readValue(event: ControlEvent): string {
  const target = (event.target ?? event.currentTarget) as { value?: unknown } | null;
  return String(target?.value ?? "");
}
function readChecked(event: ControlEvent): boolean {
  const target = (event.target ?? event.currentTarget) as { checked?: unknown } | null;
  return Boolean(target?.checked);
}

export interface MarketWithCountries {
  id: string;
  title: string;
  countryCodes: string[];
}

type Scope = "ALL_MARKETS" | "SPECIFIC_MARKETS" | "SPECIFIC_COUNTRIES";

interface Props {
  leaves: EditableLeaf[];
  onChange: (next: EditableLeaf[]) => void;
  markets: MarketWithCountries[];
  allCountries: string[];
}

function splitIds(value: string | undefined): string[] {
  return (value ?? "").split(",").filter(Boolean);
}

function marketIdLeaf(operator: "in" | "not_in", ids: string[]): EditableLeaf {
  return { id: "managed:markets:market.id", type: "condition", field: "market.id", operator, value: ids.join(",") };
}

function countryCodeLeaf(operator: "in" | "not_in", codes: string[]): EditableLeaf {
  return { id: "managed:markets:market.countryCode", type: "condition", field: "market.countryCode", operator, value: codes.join(",") };
}

/**
 * Friendlier face on market.id/market.countryCode (see condition-fields.ts),
 * resolved to concrete country codes at publish time by
 * campaign-compiler.server.ts — same engine as the generic Conditions
 * tab. Writes into the same conditionsJson tree via a "managed:markets"
 * subgroup (condition-tree-edit.ts). Exceptions reuse the same two
 * fields with the "not_in" operator instead of "in".
 */
export default function MarketsEditor({ leaves, onChange, markets, allCountries }: Props) {
  const marketLeaf = leaves.find((l) => l.field === "market.id");
  const countryLeaf = leaves.find((l) => l.field === "market.countryCode");

  const scope: Scope =
    countryLeaf?.operator === "in" ? "SPECIFIC_COUNTRIES" : marketLeaf?.operator === "in" ? "SPECIFIC_MARKETS" : "ALL_MARKETS";

  const includedMarketIds = scope === "SPECIFIC_MARKETS" ? splitIds(marketLeaf?.value) : [];
  const includedCountries = scope === "SPECIFIC_COUNTRIES" ? splitIds(countryLeaf?.value) : [];
  const excludedMarketIds = scope === "ALL_MARKETS" && marketLeaf?.operator === "not_in" ? splitIds(marketLeaf.value) : [];
  const excludedCountries = scope !== "SPECIFIC_COUNTRIES" && countryLeaf?.operator === "not_in" ? splitIds(countryLeaf.value) : [];

  // Local-only reveal toggle (see ProductsEditor's matching comment) —
  // seeded from whatever's already saved, one toggle serves both the
  // ALL_MARKETS and SPECIFIC_MARKETS branches below since only one
  // renders at a time depending on scope.
  const [showExceptions, setShowExceptions] = useState(
    () => excludedMarketIds.length > 0 || excludedCountries.length > 0,
  );

  const marketOptions = markets.map((market) => ({
    id: market.id,
    label: market.title,
    detail: market.countryCodes.map((code) => countryFlagEmoji(code)).join(" "),
  }));
  const countryOptions = allCountries.map((code) => ({ id: code, label: `${countryFlagEmoji(code)} ${countryDisplayName(code)}` }));

  // Pushes an empty marker leaf for the newly-picked scope (except
  // ALL_MARKETS, whose absence of any leaf already means "no
  // restriction") — otherwise picking e.g. "Specific markets" with
  // nothing checked yet leaves no trace once saved, `scope` re-derives
  // back to "ALL_MARKETS" on the next render, and the dropdown
  // silently reverts even though it visually still shows the
  // just-clicked option.
  const changeScope = (event: ControlEvent) => {
    const next = readValue(event) as Scope;
    if (next === "SPECIFIC_MARKETS") return onChange([marketIdLeaf("in", [])]);
    if (next === "SPECIFIC_COUNTRIES") return onChange([countryCodeLeaf("in", [])]);
    onChange([]);
  };

  const setIncludedMarkets = (ids: string[]) => onChange([marketIdLeaf("in", ids)]);
  const setIncludedCountries = (codes: string[]) => onChange([countryCodeLeaf("in", codes)]);

  const setExcludedMarkets = (ids: string[]) => {
    const next: EditableLeaf[] = [];
    if (ids.length) next.push(marketIdLeaf("not_in", ids));
    if (excludedCountries.length) next.push(countryCodeLeaf("not_in", excludedCountries));
    onChange(next);
  };

  const setExcludedCountries = (codes: string[]) => {
    const next: EditableLeaf[] = [];
    if (scope === "ALL_MARKETS" && excludedMarketIds.length) next.push(marketIdLeaf("not_in", excludedMarketIds));
    if (scope === "SPECIFIC_MARKETS" && includedMarketIds.length) next.push(marketIdLeaf("in", includedMarketIds));
    if (codes.length) next.push(countryCodeLeaf("not_in", codes));
    onChange(next);
  };

  return (
    <s-stack direction="block" gap="base">
      <s-paragraph>Restrict this campaign to specific markets or countries. Leave as &quot;All markets&quot; to match anywhere you sell.</s-paragraph>

      <s-select label="Applies to" value={scope} onChange={changeScope}>
        <s-option value="ALL_MARKETS">All markets</s-option>
        <s-option value="SPECIFIC_MARKETS">Specific markets</s-option>
        <s-option value="SPECIFIC_COUNTRIES">Specific countries</s-option>
      </s-select>

      {scope === "SPECIFIC_MARKETS" && (
        <MultiSelectPicker
          modalId="markets-picker-include-markets"
          heading="Choose markets"
          triggerLabel="Choose markets"
          emptyLabel="No markets selected."
          options={marketOptions}
          selectedIds={includedMarketIds}
          onChange={setIncludedMarkets}
        />
      )}

      {scope === "SPECIFIC_COUNTRIES" && (
        <MultiSelectPicker
          modalId="markets-picker-include-countries"
          heading="Choose countries"
          triggerLabel="Choose countries"
          emptyLabel="No countries selected."
          options={countryOptions}
          selectedIds={includedCountries}
          onChange={setIncludedCountries}
        />
      )}

      {scope !== "SPECIFIC_COUNTRIES" && (
        <s-stack direction="block" gap="small">
          <s-checkbox
            label={scope === "ALL_MARKETS" ? "Exclude specific markets or countries" : "Exclude specific countries"}
            checked={showExceptions}
            onChange={(event: ControlEvent) => {
              const checked = readChecked(event);
              setShowExceptions(checked);
              if (!checked) {
                if (scope === "ALL_MARKETS") onChange([]);
                else setIncludedMarkets(includedMarketIds);
              }
            }}
          />

          {showExceptions && (
            <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
              <s-stack direction="block" gap="base">
                {scope === "ALL_MARKETS" && (
                  <s-stack direction="block" gap="small">
                    <s-text>Excluded markets</s-text>
                    <MultiSelectPicker
                      modalId="markets-picker-exclude-markets"
                      heading="Choose markets to exclude"
                      triggerLabel="Choose markets"
                      emptyLabel="None excluded."
                      options={marketOptions}
                      selectedIds={excludedMarketIds}
                      onChange={setExcludedMarkets}
                    />
                  </s-stack>
                )}

                {scope === "ALL_MARKETS" && <s-divider />}

                <s-stack direction="block" gap="small">
                  <s-text>Excluded countries</s-text>
                  <MultiSelectPicker
                    modalId="markets-picker-exclude-countries"
                    heading="Choose countries to exclude"
                    triggerLabel="Choose countries"
                    emptyLabel="None excluded."
                    options={countryOptions}
                    selectedIds={excludedCountries}
                    onChange={setExcludedCountries}
                  />
                </s-stack>
              </s-stack>
            </s-box>
          )}
        </s-stack>
      )}

      {markets.length === 0 && (
        <s-paragraph color="subdued">
          No Shopify Markets are set up yet. Configure them in Settings → Markets to target them here.
        </s-paragraph>
      )}
    </s-stack>
  );
}

import { useState } from "react";

type ControlEvent = { target: EventTarget | null; currentTarget: EventTarget | null };
function readValue(event: ControlEvent): string {
  const target = (event.target ?? event.currentTarget) as { value?: unknown } | null;
  return String(target?.value ?? "");
}
function readChecked(event: ControlEvent): boolean {
  const target = (event.target ?? event.currentTarget) as { checked?: unknown } | null;
  return Boolean(target?.checked);
}

export interface PickerOption {
  id: string;
  label: string;
  detail?: string;
}

interface Props {
  modalId: string;
  heading: string;
  triggerLabel: string;
  emptyLabel: string;
  options: PickerOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

/**
 * A button that opens a searchable checkbox-list popup (mirroring
 * ProductsEditor's resourcePicker flow, since Shopify's own
 * shopify.resourcePicker only supports product/collection/variant —
 * there's no built-in picker for markets or countries) plus a compact
 * list of whatever's currently selected, each with its own remove
 * button.
 *
 * Checkbox toggles inside the popup only touch local draft state,
 * committed to the real conditionsJson tree in one shot when "Done" is
 * clicked — this tab's onChange auto-saves on every call (see
 * app.campaigns.$id.tsx's persistConditions), so committing per
 * checkbox click would fire a save-and-toast per click while picking
 * several countries in a row.
 */
export default function MultiSelectPicker({ modalId, heading, triggerLabel, emptyLabel, options, selectedIds, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [draftIds, setDraftIds] = useState(selectedIds);

  const openPicker = () => {
    setQuery("");
    setDraftIds(selectedIds);
  };

  const toggle = (id: string, checked: boolean) => {
    setDraftIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return [...next];
    });
  };

  const commit = () => onChange(draftIds);
  const remove = (id: string) => onChange(selectedIds.filter((existing) => existing !== id));

  const filteredOptions = query.trim()
    ? options.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  const selectedOptions = selectedIds.map((id) => options.find((option) => option.id === id)).filter((option): option is PickerOption => Boolean(option));

  return (
    <s-stack direction="block" gap="small">
      <s-button icon="search" commandFor={modalId} command="--show" onClick={openPicker}>
        {triggerLabel}
      </s-button>

      {selectedOptions.length === 0 ? (
        <s-text tone="neutral">{emptyLabel}</s-text>
      ) : (
        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" overflow="hidden">
          {selectedOptions.map((option, index) => (
            <div key={option.id}>
              {index > 0 && <s-divider />}
              <s-box padding="small">
                <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
                  <s-stack direction="block" gap="small-100">
                    <s-text>{option.label}</s-text>
                    {option.detail && <s-text color="subdued">{option.detail}</s-text>}
                  </s-stack>
                  <s-button icon="delete" tone="critical" variant="tertiary" accessibilityLabel={`Remove ${option.label}`} onClick={() => remove(option.id)} />
                </s-grid>
              </s-box>
            </div>
          ))}
        </s-box>
      )}

      <s-modal id={modalId} heading={heading}>
        <s-stack direction="block" gap="small">
          <s-search-field
            label="Search"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search"
            value={query}
            onInput={(event: ControlEvent) => setQuery(readValue(event))}
          />

          <s-scroll-box maxBlockSize="320px">
            <s-stack direction="block" gap="small-200">
              {filteredOptions.map((option) => (
                <s-checkbox
                  key={option.id}
                  label={option.detail ? `${option.label} — ${option.detail}` : option.label}
                  checked={draftIds.includes(option.id)}
                  onChange={(event: ControlEvent) => toggle(option.id, readChecked(event))}
                />
              ))}
              {filteredOptions.length === 0 && <s-text tone="neutral">No matches.</s-text>}
            </s-stack>
          </s-scroll-box>
        </s-stack>

        <s-button slot="primary-action" variant="primary" commandFor={modalId} command="--hide" onClick={commit}>
          Done
        </s-button>
      </s-modal>
    </s-stack>
  );
}

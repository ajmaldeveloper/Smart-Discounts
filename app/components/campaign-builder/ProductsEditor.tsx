import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

import type { EditableLeaf } from "../../lib/condition-tree-edit";
import type { HydratedResourceRef } from "../../services/shopify-resources.server";

type ControlEvent = { target: EventTarget | null; currentTarget: EventTarget | null };
function readValue(event: ControlEvent): string {
  const target = (event.target ?? event.currentTarget) as { value?: unknown } | null;
  return String(target?.value ?? "");
}
function readChecked(event: ControlEvent): boolean {
  const target = (event.target ?? event.currentTarget) as { checked?: unknown } | null;
  return Boolean(target?.checked);
}

type ProductScope = "ALL" | "PRODUCTS" | "COLLECTIONS" | "TAG";

type PickerImage = { originalSrc?: string; url?: string };
type PickerItem = { id: string; title: string; images?: PickerImage[] };

interface Props {
  leaves: EditableLeaf[];
  onChange: (next: EditableLeaf[]) => void;
  productRefs: HydratedResourceRef[];
  onProductRefsChange: (next: HydratedResourceRef[]) => void;
  collectionRefs: HydratedResourceRef[];
  onCollectionRefsChange: (next: HydratedResourceRef[]) => void;
}

function leaf(field: string, operator: "in" | "not_in", value: string): EditableLeaf {
  return { id: `managed:products:${field}`, type: "condition", field, operator, value };
}

function splitIds(value: string | undefined): string[] {
  return (value ?? "").split(",").filter(Boolean);
}

function pickerImage(item: PickerItem): string | null {
  return item.images?.[0]?.originalSrc || item.images?.[0]?.url || null;
}

/**
 * Same product.id/collection.id/product.tag condition fields the
 * generic Conditions tab already supports, behind a friendlier
 * resource-picker UI — writes into the same conditionsJson tree via a
 * "managed:products" subgroup (see condition-tree-edit.ts). Exceptions
 * (for the "All products" scope) reuse the same two id fields with the
 * "not_in" operator, mirroring Product Options' AssignmentTab.
 *
 * The id/title/image cache for currently-selected products and
 * collections lives in the PARENT (app.campaigns.$id.tsx), not here —
 * this tab unmounts every time the merchant switches to another tab
 * (each tab is conditionally rendered), so any cache kept in this
 * component's own state would silently reset to the last-saved
 * titles, discarding an unsaved picker selection.
 */
export default function ProductsEditor({
  leaves,
  onChange,
  productRefs,
  onProductRefsChange,
  collectionRefs,
  onCollectionRefsChange,
}: Props) {
  const shopify = useAppBridge();

  const productLeaf = leaves.find((l) => l.field === "product.id");
  const collectionLeaf = leaves.find((l) => l.field === "collection.id");
  const tagLeaf = leaves.find((l) => l.field === "product.tag");

  const scope: ProductScope =
    tagLeaf?.operator === "in"
      ? "TAG"
      : productLeaf?.operator === "in"
        ? "PRODUCTS"
        : collectionLeaf?.operator === "in"
          ? "COLLECTIONS"
          : "ALL";

  const includedProductIds = scope === "PRODUCTS" ? splitIds(productLeaf?.value) : [];
  const includedCollectionIds = scope === "COLLECTIONS" ? splitIds(collectionLeaf?.value) : [];
  const excludedProductIds = scope === "ALL" && productLeaf?.operator === "not_in" ? splitIds(productLeaf.value) : [];
  const excludedCollectionIds = scope === "ALL" && collectionLeaf?.operator === "not_in" ? splitIds(collectionLeaf.value) : [];
  const tagsText = tagLeaf?.value ?? "";

  // Local-only reveal toggle, seeded from whatever's already saved —
  // this isn't a "scope" needing a persisted marker for an empty
  // selection (see changeScope's own comment on that bug class):
  // unchecking with nothing picked and reloading later would just show
  // an unchecked box again, which matches reality (no exceptions
  // exist), unlike a scope dropdown silently reverting to a different
  // meaning.
  const [showExceptions, setShowExceptions] = useState(
    () => excludedProductIds.length > 0 || excludedCollectionIds.length > 0,
  );

  const refFor = (id: string) => [...productRefs, ...collectionRefs].find((ref) => ref.id === id);

  // Pushes an empty marker leaf for the newly-picked scope (except
  // ALL, whose absence of any leaf already means "no restriction") —
  // otherwise picking e.g. "Specific collections" with nothing chosen
  // yet leaves no trace once saved, `scope` re-derives back to "ALL"
  // on the next render (since no product/collection/tag leaf exists),
  // and the dropdown silently reverts even though it visually still
  // shows the just-clicked option.
  const changeScope = (event: ControlEvent) => {
    const next = readValue(event) as ProductScope;
    if (next === "PRODUCTS") return onChange([leaf("product.id", "in", "")]);
    if (next === "COLLECTIONS") return onChange([leaf("collection.id", "in", "")]);
    if (next === "TAG") return onChange([leaf("product.tag", "in", "")]);
    onChange([]);
  };

  const chooseProducts = async (current: string[], onPicked: (ids: string[]) => void) => {
    const selected = (await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: true,
      selectionIds: current.map((id) => ({ id })),
      filter: { variants: false, archived: false },
    })) as PickerItem[] | undefined;
    if (!selected) return;

    onProductRefsChange([
      ...productRefs.filter((ref) => !selected.some((item) => item.id === ref.id)),
      ...selected.map((item) => ({ id: item.id, title: item.title, imageUrl: pickerImage(item) })),
    ]);
    onPicked(selected.map((item) => item.id));
  };

  const chooseCollections = async (current: string[], onPicked: (ids: string[]) => void) => {
    const selected = (await shopify.resourcePicker({
      type: "collection",
      action: "select",
      multiple: true,
      selectionIds: current.map((id) => ({ id })),
    })) as PickerItem[] | undefined;
    if (!selected) return;

    onCollectionRefsChange([
      ...collectionRefs.filter((ref) => !selected.some((item) => item.id === ref.id)),
      ...selected.map((item) => ({ id: item.id, title: item.title, imageUrl: pickerImage(item) })),
    ]);
    onPicked(selected.map((item) => item.id));
  };

  const setIncluded = (productIds: string[], collectionIds: string[]) => {
    const next: EditableLeaf[] = [];
    if (productIds.length) next.push(leaf("product.id", "in", productIds.join(",")));
    if (collectionIds.length) next.push(leaf("collection.id", "in", collectionIds.join(",")));
    onChange(next);
  };

  const setExcluded = (productIds: string[], collectionIds: string[]) => {
    const next: EditableLeaf[] = [];
    if (productIds.length) next.push(leaf("product.id", "not_in", productIds.join(",")));
    if (collectionIds.length) next.push(leaf("collection.id", "not_in", collectionIds.join(",")));
    onChange(next);
  };

  function ResourceRows({ ids, onRemove }: { ids: string[]; onRemove: (id: string) => void }) {
    if (ids.length === 0) return <s-text tone="neutral">None selected.</s-text>;

    return (
      <s-box borderWidth="base" borderColor="subdued" borderRadius="base" overflow="hidden">
        {ids.map((id, index) => {
          const ref = refFor(id);
          return (
            <div key={id}>
              {index > 0 && <s-divider />}
              <s-box padding="small">
                <s-grid gridTemplateColumns="auto 1fr auto" gap="small" alignItems="center">
                  <s-thumbnail src={ref?.imageUrl ?? undefined} alt={ref?.title ?? "Product unavailable"} size="small" />
                  {ref ? (
                    <s-text>{ref.title}</s-text>
                  ) : (
                    <s-stack direction="block" gap="small-400">
                      <s-text tone="critical">Product unavailable</s-text>
                      <s-text color="subdued">
                        This product may have been deleted, or belongs to a different store. Remove it and choose again.
                      </s-text>
                    </s-stack>
                  )}
                  <s-button
                    icon="delete"
                    tone="critical"
                    variant="tertiary"
                    accessibilityLabel={`Remove ${ref?.title ?? "unavailable product"}`}
                    onClick={() => onRemove(id)}
                  />
                </s-grid>
              </s-box>
            </div>
          );
        })}
      </s-box>
    );
  }

  return (
    <s-stack direction="block" gap="base">
      <s-paragraph>
        Restrict this campaign to specific products. Leave as &quot;All products&quot; to match anything in the cart.
      </s-paragraph>

      <s-select label="Applies to" value={scope} onChange={changeScope}>
        <s-option value="ALL">All products</s-option>
        <s-option value="PRODUCTS">Specific products</s-option>
        <s-option value="COLLECTIONS">Specific collections</s-option>
        <s-option value="TAG">Products with a tag</s-option>
      </s-select>

      {scope === "PRODUCTS" && (
        <s-stack direction="block" gap="small">
          <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
            <s-text type="strong">Products</s-text>
            <s-button icon="product" onClick={() => chooseProducts(includedProductIds, (ids) => setIncluded(ids, []))}>
              Choose products
            </s-button>
          </s-grid>
          <ResourceRows
            ids={includedProductIds}
            onRemove={(id) => setIncluded(includedProductIds.filter((i) => i !== id), [])}
          />
        </s-stack>
      )}

      {scope === "COLLECTIONS" && (
        <s-stack direction="block" gap="small">
          <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
            <s-text type="strong">Collections</s-text>
            <s-button icon="collection" onClick={() => chooseCollections(includedCollectionIds, (ids) => setIncluded([], ids))}>
              Choose collections
            </s-button>
          </s-grid>
          <ResourceRows
            ids={includedCollectionIds}
            onRemove={(id) => setIncluded([], includedCollectionIds.filter((i) => i !== id))}
          />
        </s-stack>
      )}

      {scope === "TAG" && (
        <s-text-field
          label="Product tags"
          value={tagsText}
          placeholder="Summer, Sale"
          details="Comma-separated. Matches if the product carries any of these tags."
          onInput={(event: ControlEvent) => onChange(readValue(event).trim() ? [leaf("product.tag", "in", readValue(event))] : [])}
        />
      )}

      {scope === "ALL" && (
        <s-stack direction="block" gap="small">
          <s-checkbox
            label="Exclude specific products or collections"
            checked={showExceptions}
            onChange={(event: ControlEvent) => {
              const checked = readChecked(event);
              setShowExceptions(checked);
              if (!checked) onChange([]);
            }}
          />

          {showExceptions && (
            <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
              <s-stack direction="block" gap="base">
                <s-stack direction="block" gap="small">
                  <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
                    <s-text>Excluded products</s-text>
                    <s-button
                      icon="product"
                      onClick={() => chooseProducts(excludedProductIds, (ids) => setExcluded(ids, excludedCollectionIds))}
                    >
                      Choose products
                    </s-button>
                  </s-grid>
                  <ResourceRows
                    ids={excludedProductIds}
                    onRemove={(id) => setExcluded(excludedProductIds.filter((i) => i !== id), excludedCollectionIds)}
                  />
                </s-stack>

                <s-divider />

                <s-stack direction="block" gap="small">
                  <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
                    <s-text>Excluded collections</s-text>
                    <s-button
                      icon="collection"
                      onClick={() => chooseCollections(excludedCollectionIds, (ids) => setExcluded(excludedProductIds, ids))}
                    >
                      Choose collections
                    </s-button>
                  </s-grid>
                  <ResourceRows
                    ids={excludedCollectionIds}
                    onRemove={(id) => setExcluded(excludedProductIds, excludedCollectionIds.filter((i) => i !== id))}
                  />
                </s-stack>
              </s-stack>
            </s-box>
          )}
        </s-stack>
      )}
    </s-stack>
  );
}

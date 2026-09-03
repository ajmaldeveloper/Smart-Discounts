import { useEffect, useRef, useState } from "react";
import { CONDITION_FIELDS, getConditionField, operatorsForField } from "../../lib/condition-fields";
import { operatorLabel, type ConditionOperator } from "../../lib/campaign-types";
import {
  addChildToGroup,
  createEditableLeaf,
  MANAGED_GROUP_IDS,
  removeNodeById,
  replaceNode,
  type EditableGroup,
  type EditableLeaf,
} from "../../lib/condition-tree-edit";

const MODAL_ID = "winslet-condition-modal";

// Mirrors product-options's LogicTab.tsx convention: s-select fires
// onChange, s-text-field fires onInput, both read the same way.
type ControlEvent = { target: EventTarget | null; currentTarget: EventTarget | null };
function readControlValue(event: ControlEvent): string {
  const target = (event.target ?? event.currentTarget) as { value?: unknown } | null;
  return String(target?.value ?? "");
}

type OverlayElement = HTMLElement & { hideOverlay?: () => void };
function hideOverlay(id: string) {
  (document.getElementById(id) as OverlayElement | null)?.hideOverlay?.();
}

interface Props {
  value: EditableGroup;
  // `message` is shown as the toast confirming this specific change
  // (e.g. "Condition deleted.") instead of a generic "Conditions
  // saved." for every kind of edit — see app.campaigns.$id.tsx's
  // persistConditions.
  onChange: (next: EditableGroup, message?: string) => void;
  saving?: boolean;
}

interface Draft {
  groupId: string;
  leafId: string | null;
  field: string;
  // Always the canonical/positive form — see resolveOperator for how
  // this combines with `action` into the operator actually stored.
  operator: ConditionOperator;
  action: Action;
  value: string;
  label: string;
}

function visibleChildrenOf(group: EditableGroup) {
  return group.children.filter((child) => !MANAGED_GROUP_IDS.includes(child.id));
}

function describeLeaf(field: string, operator: ConditionOperator, value: string): string {
  const fieldLabel = getConditionField(field)?.label ?? field;
  if (operator === "is_empty" || operator === "is_not_empty") {
    return `${fieldLabel} ${operatorLabel(operator)}`;
  }
  return `${fieldLabel} ${operatorLabel(operator).toLowerCase()} ${value || "…"}`;
}

// The Operator dropdown only ever shows the positive/canonical form of
// each pair (equals, contains, in, is_empty) — whether a match means
// "apply" or "exclude" is chosen explicitly via the Action select
// below, which maps onto picking the plain operator vs. its negated
// counterpart. Keeping exactly one source of truth (this map) means
// the dropdown, the Action select, and the summary text can never
// disagree about what a given stored operator actually means.
const POSITIVE_TO_NEGATIVE: Partial<Record<ConditionOperator, ConditionOperator>> = {
  equals: "not_equals",
  contains: "not_contains",
  in: "not_in",
  is_empty: "is_not_empty",
};
const NEGATIVE_TO_POSITIVE: Partial<Record<ConditionOperator, ConditionOperator>> = {
  not_equals: "equals",
  not_contains: "contains",
  not_in: "in",
  is_not_empty: "is_empty",
};

function canonicalOperator(operator: ConditionOperator): ConditionOperator {
  return NEGATIVE_TO_POSITIVE[operator] ?? operator;
}

type Action = "APPLY" | "EXCLUDE";

function actionOf(operator: ConditionOperator): Action {
  return NEGATIVE_TO_POSITIVE[operator] !== undefined ? "EXCLUDE" : "APPLY";
}

function actionFor(operator: ConditionOperator): string {
  return actionOf(operator) === "EXCLUDE" ? "Not apply this discount" : "Apply this discount";
}

function resolveOperator(canonical: ConditionOperator, action: Action): ConditionOperator {
  if (action === "APPLY") return canonical;
  return POSITIVE_TO_NEGATIVE[canonical] ?? canonical;
}

export default function ConditionsEditor({ value, onChange, saving = false }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const visibleChildren = visibleChildrenOf(value);
  const isEditing = draft?.leafId !== null && draft?.leafId !== undefined;

  // The popup stays open (with the primary button spinning) for the
  // whole round trip instead of closing the instant Save is clicked —
  // closing immediately meant the modal was gone well before the
  // "Condition saved." toast actually appeared, which read as if
  // nothing had happened in between. `saveInFlight` remembers that
  // `saving` really did go true at some point, so the close only fires
  // on that true→false transition (the request actually finishing),
  // never on the very next render where `saving` just hasn't flipped
  // to true yet.
  const saveInFlight = useRef(false);
  useEffect(() => {
    if (saving) {
      saveInFlight.current = true;
    } else if (saveInFlight.current) {
      saveInFlight.current = false;
      setDraft((current) => {
        if (current) hideOverlay(MODAL_ID);
        return null;
      });
    }
  }, [saving]);

  const openAdd = (groupId: string) => {
    const field = CONDITION_FIELDS[0]!;
    const operator = canonicalOperator(field.operators[0]!);
    setAttemptedSave(false);
    setDraft({ groupId, leafId: null, field: field.field, operator, action: "APPLY", value: "", label: "" });
  };

  const openEdit = (groupId: string, leaf: EditableLeaf) => {
    setAttemptedSave(false);
    setDraft({
      groupId,
      leafId: leaf.id,
      field: leaf.field,
      operator: canonicalOperator(leaf.operator),
      action: actionOf(leaf.operator),
      value: leaf.value,
      label: leaf.label ?? "",
    });
  };

  const needsValue = draft ? draft.operator !== "is_empty" : false;
  const nameError = attemptedSave && !draft?.label.trim() ? "Enter a name for this condition." : undefined;
  const valueError = attemptedSave && needsValue && !draft?.value.trim() ? "Enter a value." : undefined;

  const save = () => {
    if (!draft) return;

    const label = draft.label.trim();
    if (!label || (needsValue && !draft.value.trim())) {
      setAttemptedSave(true);
      return;
    }

    const operator = resolveOperator(draft.operator, draft.action);

    if (draft.leafId) {
      onChange(
        replaceNode(value, draft.leafId, (node) =>
          node.type === "condition" ? { ...node, field: draft.field, operator, value: draft.value, label } : node,
        ),
        "Condition updated.",
      );
    } else {
      const newLeaf = createEditableLeaf(draft.field, operator);
      onChange(addChildToGroup(value, draft.groupId, { ...newLeaf, value: draft.value, label }), "Condition added.");
    }
  };

  const fieldDef = draft ? getConditionField(draft.field) : undefined;
  const operators = draft ? operatorsForField(draft.field) : [];
  const canonicalOperators = [...new Set(operators.map(canonicalOperator))];
  const canExclude = draft ? operators.includes(POSITIVE_TO_NEGATIVE[draft.operator] ?? ("" as ConditionOperator)) : false;
  const finalOperator = draft ? resolveOperator(draft.operator, draft.action) : "equals";

  return (
    <s-stack direction="block" gap="base">
      <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-badge tone="info">WHEN</s-badge>
          <s-text color="subdued">Choose what must be true.</s-text>
        </s-stack>
        <s-button icon="plus" disabled={saving} commandFor={MODAL_ID} command="--show" onClick={() => openAdd(value.id)}>
          Add
        </s-button>
      </s-grid>

      {visibleChildren.length === 0 ? (
        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="large-500">
          <s-stack direction="block" gap="small" alignItems="center">
            <s-box padding="small-400" borderRadius="base" background="subdued">
              <s-text type="strong">IF</s-text>
            </s-box>
            <s-text type="strong">No conditions yet</s-text>
            <s-text color="subdued">Add a condition — this campaign will match every order until you do.</s-text>
            <s-button variant="primary" icon="plus" disabled={saving} commandFor={MODAL_ID} command="--show" onClick={() => openAdd(value.id)}>
              Create first condition
            </s-button>
          </s-stack>
        </s-box>
      ) : (
        <s-box borderWidth="base" borderColor="subdued" borderRadius="base" overflow="hidden">
          <GroupEditor group={value} root={value} onChange={onChange} depth={0} onAdd={openAdd} onEdit={openEdit} saving={saving} />
        </s-box>
      )}

      <s-modal id={MODAL_ID} heading={isEditing ? "Edit condition" : "Add condition"}>
        {draft && (
          <s-stack direction="block" gap="base">
            <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
              <s-stack direction="block" gap="small">
                <s-text-field
                  label="Condition name"
                  required
                  value={draft.label}
                  placeholder="e.g. VIP customers only"
                  details="For your own recognition — shown on the condition row. The summary below always reflects the real logic."
                  error={nameError}
                  onInput={(event: ControlEvent) => setDraft({ ...draft, label: readControlValue(event) })}
                />
              </s-stack>
            </s-box>

            <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base">
              <s-stack direction="block" gap="base">
                <s-stack direction="block" gap="small">
                  <s-select
                    label="Field"
                    value={draft.field}
                    onChange={(event: ControlEvent) => {
                      const nextField = readControlValue(event);
                      const nextOperators = operatorsForField(nextField);
                      setDraft({ ...draft, field: nextField, operator: canonicalOperator(nextOperators[0] ?? "equals"), action: "APPLY", value: "" });
                    }}
                  >
                    {CONDITION_FIELDS.map((f) => (
                      <s-option key={f.field} value={f.field}>
                        {f.label}
                      </s-option>
                    ))}
                  </s-select>

                  <s-select
                    label="Operator"
                    value={draft.operator}
                    onChange={(event: ControlEvent) =>
                      setDraft({ ...draft, operator: readControlValue(event) as ConditionOperator })
                    }
                  >
                    {canonicalOperators.map((operator) => (
                      <s-option key={operator} value={operator}>
                        {operatorLabel(operator)}
                      </s-option>
                    ))}
                  </s-select>

                  {needsValue ? (
                    <s-text-field
                      label="Value"
                      required
                      value={draft.value}
                      placeholder={
                        draft.operator === "between"
                          ? "e.g. 100, 200"
                          : (fieldDef?.placeholder ?? (fieldDef?.valueType === "number" ? "e.g. 100" : "Value"))
                      }
                      details={fieldDef?.helpText}
                      error={valueError}
                      onInput={(event: ControlEvent) => setDraft({ ...draft, value: readControlValue(event) })}
                    />
                  ) : (
                    <s-text tone="neutral">No value needed</s-text>
                  )}
                </s-stack>

                {canExclude && (
                  <>
                    <s-divider />
                    <s-select
                      label="When this matches"
                      value={draft.action}
                      details="Choose whether a match should let this discount apply, or block it."
                      onChange={(event: ControlEvent) => setDraft({ ...draft, action: readControlValue(event) as Action })}
                    >
                      <s-option value="APPLY">Apply this discount</s-option>
                      <s-option value="EXCLUDE">Not apply this discount</s-option>
                    </s-select>
                  </>
                )}

                <s-box padding="base" borderRadius="base" background="subdued">
                  <s-stack direction="block" gap="small-200">
                    <s-text type="strong">Summary</s-text>
                    <s-text color="subdued">
                      WHEN {describeLeaf(draft.field, finalOperator, draft.value)} → {actionFor(finalOperator)}
                    </s-text>
                  </s-stack>
                </s-box>
              </s-stack>
            </s-box>
          </s-stack>
        )}

        <s-button slot="secondary-actions" variant="secondary" commandFor={MODAL_ID} command="--hide" onClick={() => setDraft(null)}>
          Cancel
        </s-button>
        <s-button slot="primary-action" variant="primary" loading={saving} disabled={saving} onClick={save}>
          {isEditing ? "Save changes" : "Save condition"}
        </s-button>
      </s-modal>
    </s-stack>
  );
}

function GroupEditor({
  group,
  root,
  onChange,
  depth,
  onAdd,
  onEdit,
  saving,
}: {
  group: EditableGroup;
  root: EditableGroup;
  onChange: (next: EditableGroup, message?: string) => void;
  depth: number;
  onAdd: (groupId: string) => void;
  onEdit: (groupId: string, leaf: EditableLeaf) => void;
  saving: boolean;
}) {
  const visibleChildren = visibleChildrenOf(group);
  const padding = depth === 0 ? "base" : "small";

  if (depth > 0) {
    return (
      <s-box borderWidth="base" borderColor="subdued" borderRadius="base" padding="base" background="subdued">
        <s-stack direction="block" gap="small">
          <s-grid gridTemplateColumns="1fr auto auto" gap="small" alignItems="end">
            <s-select
              label="Match"
              value={group.combinator}
              disabled={saving}
              onChange={(event: ControlEvent) => {
                const nextCombinator = readControlValue(event) === "ANY" ? "ANY" : "ALL";
                onChange(
                  replaceNode(root, group.id, (node) => (node.type === "group" ? { ...node, combinator: nextCombinator } : node)),
                  "Group updated.",
                );
              }}
            >
              <s-option value="ALL">ALL conditions</s-option>
              <s-option value="ANY">ANY condition</s-option>
            </s-select>

            <s-button icon="plus" variant="tertiary" disabled={saving} commandFor={MODAL_ID} command="--show" onClick={() => onAdd(group.id)}>
              Add
            </s-button>

            <s-button
              icon="delete"
              tone="critical"
              variant="tertiary"
              disabled={saving}
              accessibilityLabel="Remove group"
              onClick={() => onChange(removeNodeById(root, group.id), "Group removed.")}
            />
          </s-grid>

          {visibleChildren.length === 0 ? (
            <s-text tone="neutral">Empty group — add a condition or remove it.</s-text>
          ) : (
            <s-box borderWidth="base" borderColor="subdued" borderRadius="base" background="base" overflow="hidden">
              {visibleChildren.map((child, index) => (
                <div key={child.id}>
                  {index > 0 && <s-divider />}
                  {child.type === "condition" ? (
                    <ConditionRow leaf={child} root={root} index={index} groupId={group.id} onChange={onChange} onEdit={onEdit} saving={saving} />
                  ) : (
                    <GroupEditor group={child} root={root} onChange={onChange} depth={depth + 1} onAdd={onAdd} onEdit={onEdit} saving={saving} />
                  )}
                </div>
              ))}
            </s-box>
          )}
        </s-stack>
      </s-box>
    );
  }

  const content = (
    <s-stack direction="block" gap="small">
      {visibleChildren.map((child, index) => (
        <div key={child.id}>
          <s-divider />
          {child.type === "condition" ? (
            <ConditionRow
              leaf={child}
              root={root}
              index={index}
              groupId={group.id}
              onChange={onChange}
              onEdit={onEdit}
              saving={saving}
            />
          ) : (
            <GroupEditor group={child} root={root} onChange={onChange} depth={depth + 1} onAdd={onAdd} onEdit={onEdit} saving={saving} />
          )}
        </div>
      ))}

      {depth > 0 && (
        <>
          <s-divider />
          <s-box padding={padding}>
            <s-stack direction="inline" gap="small">
              <s-button icon="plus" variant="tertiary" disabled={saving} commandFor={MODAL_ID} command="--show" onClick={() => onAdd(group.id)}>
                Add
              </s-button>
              <s-button
                icon="delete"
                tone="critical"
                variant="tertiary"
                disabled={saving}
                onClick={() => onChange(removeNodeById(root, group.id), "Group removed.")}
              >
                Remove group
              </s-button>
            </s-stack>
          </s-box>
        </>
      )}
    </s-stack>
  );

  if (depth === 0) return content;

  return (
    <div style={{ paddingInlineStart: "1rem", borderInlineStart: "2px solid var(--p-color-border-secondary, #d1d1d1)" }}>{content}</div>
  );
}

function ConditionRow({
  leaf,
  root,
  index,
  groupId,
  onChange,
  onEdit,
  saving,
}: {
  leaf: EditableLeaf;
  root: EditableGroup;
  index: number;
  groupId: string;
  onChange: (next: EditableGroup, message?: string) => void;
  onEdit: (groupId: string, leaf: EditableLeaf) => void;
  saving: boolean;
}) {
  const logic = describeLeaf(leaf.field, leaf.operator, leaf.value);
  const enabled = leaf.enabled !== false;
  const name = leaf.label || logic;

  const toggleEnabled = () =>
    onChange(
      replaceNode(root, leaf.id, (node) => (node.type === "condition" ? { ...node, enabled: !enabled } : node)),
      enabled ? "Condition paused." : "Condition enabled.",
    );

  return (
    <s-box padding="base">
      <s-grid gridTemplateColumns="auto 1fr auto auto auto" gap="small" alignItems="center">
        <s-badge>{String(index + 1)}</s-badge>

        <s-stack direction="block" gap="small-100">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-text type="strong">{name}</s-text>
            <s-badge tone={enabled ? "success" : "neutral"}>{enabled ? "Enabled" : "Paused"}</s-badge>
          </s-stack>
          <s-text color="subdued">
            {logic} → {actionFor(leaf.operator)}
          </s-text>
        </s-stack>

        <s-button variant="tertiary" disabled={saving} onClick={toggleEnabled}>
          {enabled ? "Pause" : "Enable"}
        </s-button>

        <s-button
          icon="edit"
          variant="tertiary"
          disabled={saving}
          commandFor={MODAL_ID}
          command="--show"
          accessibilityLabel={`Edit ${name}`}
          onClick={() => onEdit(groupId, leaf)}
        >
          Edit
        </s-button>

        <s-button
          icon="delete"
          tone="critical"
          variant="tertiary"
          disabled={saving}
          accessibilityLabel={`Remove ${name}`}
          onClick={() => onChange(removeNodeById(root, leaf.id), "Condition deleted.")}
        />
      </s-grid>
    </s-box>
  );
}

import { afterEach, describe, expect, it } from "vitest";
import db from "../db.server";
import { declareExperimentWinner, getExperimentSibling, startExperiment, updateExperimentWeight } from "./campaign.server";

afterEach(async () => {
  await db.shop.deleteMany({ where: { domain: { startsWith: "campaign-model-test-" } } });
});

async function makeShop() {
  return db.shop.create({ data: { domain: `campaign-model-test-${Math.random().toString(36).slice(2)}.myshopify.com` } });
}

async function makeCampaign(shopId: string, overrides: Partial<{ name: string; status: string }> = {}) {
  return db.campaign.create({
    data: {
      shopId,
      name: "Spring Sale",
      kind: "AUTOMATIC",
      status: "DRAFT",
      conditionsJson: { id: "root", type: "group", combinator: "ALL", children: [] },
      rewardJson: { order: { value: { type: "percentage", value: 10 } } },
      ...overrides,
    },
  });
}

describe("startExperiment", () => {
  it("renames the original to Variant A and creates a Variant B draft sharing its targeting", async () => {
    const shop = await makeShop();
    const original = await makeCampaign(shop.id, { name: "Spring Sale", status: "ACTIVE" });

    const result = await startExperiment(shop.id, original.id);

    expect(result).not.toBeNull();
    expect(result!.variantA.name).toBe("Spring Sale — Variant A");
    expect(result!.variantA.experimentVariant).toBe("A");
    expect(result!.variantA.experimentWeight).toBe(50);
    expect(result!.variantA.experimentId).toBe(result!.variantB.experimentId);

    expect(result!.variantB.name).toBe("Spring Sale — Variant B");
    expect(result!.variantB.experimentVariant).toBe("B");
    expect(result!.variantB.status).toBe("DRAFT");
    expect(result!.variantB.discountCode).toBeNull();
    expect(result!.variantB.conditionsJson).toEqual(original.conditionsJson);
    expect(result!.variantB.rewardJson).toEqual(original.rewardJson);
  });

  it("returns null when the campaign is already part of an experiment", async () => {
    const shop = await makeShop();
    const original = await makeCampaign(shop.id, { status: "ACTIVE" });
    await startExperiment(shop.id, original.id);

    expect(await startExperiment(shop.id, original.id)).toBeNull();
  });

  it("returns null for a nonexistent campaign", async () => {
    const shop = await makeShop();
    expect(await startExperiment(shop.id, "does-not-exist")).toBeNull();
  });
});

describe("getExperimentSibling", () => {
  it("finds the other variant sharing an experimentId", async () => {
    const shop = await makeShop();
    const original = await makeCampaign(shop.id, { status: "ACTIVE" });
    const { variantA, variantB } = (await startExperiment(shop.id, original.id))!;

    const siblingOfA = await getExperimentSibling(shop.id, variantA);
    expect(siblingOfA?.id).toBe(variantB.id);

    const siblingOfB = await getExperimentSibling(shop.id, variantB);
    expect(siblingOfB?.id).toBe(variantA.id);
  });

  it("returns null for a campaign with no experimentId", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id);
    expect(await getExperimentSibling(shop.id, campaign)).toBeNull();
  });
});

describe("updateExperimentWeight", () => {
  it("writes the weight onto the A row even when called through the B row", async () => {
    const shop = await makeShop();
    const original = await makeCampaign(shop.id, { status: "ACTIVE" });
    const { variantA, variantB } = (await startExperiment(shop.id, original.id))!;

    const updated = await updateExperimentWeight(shop.id, variantB.id, 80);

    expect(updated?.id).toBe(variantA.id);
    expect(updated?.experimentWeight).toBe(80);
  });

  it("clamps to the 0-100 range", async () => {
    const shop = await makeShop();
    const original = await makeCampaign(shop.id, { status: "ACTIVE" });
    const { variantA } = (await startExperiment(shop.id, original.id))!;

    expect((await updateExperimentWeight(shop.id, variantA.id, 150))?.experimentWeight).toBe(100);
    expect((await updateExperimentWeight(shop.id, variantA.id, -20))?.experimentWeight).toBe(0);
  });

  it("returns null for a campaign not part of an experiment", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id);
    expect(await updateExperimentWeight(shop.id, campaign.id, 60)).toBeNull();
  });
});

describe("declareExperimentWinner", () => {
  it("clears experiment fields and the Variant suffix on both campaigns", async () => {
    const shop = await makeShop();
    const original = await makeCampaign(shop.id, { name: "Spring Sale", status: "ACTIVE" });
    const { variantA, variantB } = (await startExperiment(shop.id, original.id))!;

    const result = await declareExperimentWinner(shop.id, variantA.id);

    expect(result?.winner.name).toBe("Spring Sale");
    expect(result?.winner.experimentId).toBeNull();
    expect(result?.winner.experimentVariant).toBeNull();
    expect(result?.winner.experimentWeight).toBeNull();

    expect(result?.loser?.id).toBe(variantB.id);
    expect(result?.loser?.name).toBe("Spring Sale");
    expect(result?.loser?.experimentId).toBeNull();
  });

  it("returns null for a campaign that isn't part of an experiment", async () => {
    const shop = await makeShop();
    const campaign = await makeCampaign(shop.id);
    expect(await declareExperimentWinner(shop.id, campaign.id)).toBeNull();
  });
});

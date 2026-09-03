import { describe, expect, it } from "vitest";
import { parseBuyerData } from "./buyer-data.server";

describe("parseBuyerData", () => {
  it("returns empty defaults for null/missing value", () => {
    expect(parseBuyerData(null)).toEqual({ tags: [], usage: {} });
    expect(parseBuyerData(undefined)).toEqual({ tags: [], usage: {} });
  });

  it("returns empty defaults for malformed JSON instead of throwing", () => {
    expect(parseBuyerData("not json")).toEqual({ tags: [], usage: {} });
  });

  it("parses both tags and usage together", () => {
    expect(parseBuyerData('{"tags":["VIP","Newsletter"],"usage":{"campaign-1":2}}')).toEqual({
      tags: ["VIP", "Newsletter"],
      usage: { "campaign-1": 2 },
    });
  });

  it("drops non-string tags and non-number usage entries rather than failing the whole parse", () => {
    expect(parseBuyerData('{"tags":["VIP",42],"usage":{"a":1,"b":"not-a-number"}}')).toEqual({
      tags: ["VIP"],
      usage: { a: 1 },
    });
  });

  it("defaults a missing field to empty while preserving the other", () => {
    expect(parseBuyerData('{"tags":["VIP"]}')).toEqual({ tags: ["VIP"], usage: {} });
    expect(parseBuyerData('{"usage":{"a":1}}')).toEqual({ tags: [], usage: { a: 1 } });
  });
});

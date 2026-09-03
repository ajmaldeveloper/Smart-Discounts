/**
 * extensions/winslet-discounts/src/context.ts's parseBuyerData is a
 * deliberate duplicate of app/services/buyer-data.server.ts's
 * parseBuyerData (see condition-engine.ts's module comment for the
 * full rationale).
 */
import { describe, expect, it } from "vitest";
import { parseBuyerData as adminParse } from "../services/buyer-data.server";
// eslint-disable-next-line import/no-relative-packages -- deliberate cross-package import, test-only
import { parseBuyerData as functionParse } from "../../extensions/winslet-discounts/src/context";

describe("buyer data parsing parity", () => {
  it.each([
    null,
    undefined,
    "not json",
    '{"tags":["VIP","Newsletter"],"usage":{"campaign-1":2}}',
    '{"tags":["VIP",42],"usage":{"a":1,"b":"not-a-number"}}',
    '{"tags":["VIP"]}',
    '{"usage":{"a":1}}',
  ])("agrees for %j", (value) => {
    expect(functionParse(value)).toEqual(adminParse(value));
  });
});

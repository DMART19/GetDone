import { describe, expect, it } from "vitest";
import { mentionedAuthorizedBusinesses } from "./business-routing";
const businesses = [
  { id: "a", portfolioId: "pa", name: "Sacramento Rentals" },
  { id: "b", portfolioId: "pb", name: "Capital Junk Hauling" }
];
describe("advisory authorized business name routing guard", () => {
  it("identifies complete explicit business mentions", () => {
    expect(mentionedAuthorizedBusinesses("Check Sacramento Rentals today", businesses).map(b => b.portfolioId)).toEqual(["pa"]);
    expect(mentionedAuthorizedBusinesses("Check capital junk hauling", businesses).map(b => b.portfolioId)).toEqual(["pb"]);
  });
  it("detects cross-business mention ambiguity without selecting a scope", () => {
    expect(mentionedAuthorizedBusinesses("Compare Sacramento Rentals and Capital Junk Hauling", businesses)).toHaveLength(2);
    expect(mentionedAuthorizedBusinesses("Check rentals and junk hauling", businesses)).toHaveLength(0);
  });
  it("does not match partial words", () => {
    expect(mentionedAuthorizedBusinesses("Sacramento RentalsPro", businesses)).toHaveLength(0);
  });
});

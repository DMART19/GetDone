export interface Business {
  id: string;
  portfolioId: string;
  name: string;
  lastActivityAt?: string;
}

export const businessSections = ["objectives", "integrations", "signals", "decisions", "jobs", "outcomes"] as const;
export type BusinessSection = typeof businessSections[number];
export interface BusinessRecord {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}
export interface BusinessContext {
  business: Business;
  sections: Record<BusinessSection, { records: BusinessRecord[]; note?: string }>;
}

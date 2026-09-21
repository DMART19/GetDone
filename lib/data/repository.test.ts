import { afterEach, describe, expect, it } from "vitest";
import { developmentOwnerRepository } from "@/lib/data/repository";

const originalRuntime = process.env.GETDONE_RUNTIME_ENV;
const originalDataMode = process.env.GETDONE_DATA_MODE;

afterEach(() => {
  if (originalRuntime === undefined) delete process.env.GETDONE_RUNTIME_ENV;
  else process.env.GETDONE_RUNTIME_ENV = originalRuntime;
  if (originalDataMode === undefined) delete process.env.GETDONE_DATA_MODE;
  else process.env.GETDONE_DATA_MODE = originalDataMode;
});

describe("development owner repository seam", () => {
  it("reads seeded decisions, resources, details, and summaries only in allowed development mode", async () => {
    process.env.GETDONE_RUNTIME_ENV = "development";
    process.env.GETDONE_DATA_MODE = "development-seed";

    expect((await developmentOwnerRepository.listDecisions()).length).toBeGreaterThan(0);
    expect((await developmentOwnerRepository.getDecision("approve-dc-west"))?.id).toBe("approve-dc-west");
    expect(await developmentOwnerRepository.getDecision("missing")).toBeNull();

    expect((await developmentOwnerRepository.listResources()).length).toBeGreaterThan(0);
    expect((await developmentOwnerRepository.getResource("home-pi"))?.id).toBe("home-pi");
    expect(await developmentOwnerRepository.getResource("missing")).toBeNull();
    expect((await developmentOwnerRepository.getResourceSummary()).health).toBe("Healthy");
  });

  it("fails closed when seed mode is absent or the authoritative runtime is production", async () => {
    process.env.GETDONE_RUNTIME_ENV = "development";
    delete process.env.GETDONE_DATA_MODE;
    await expect(developmentOwnerRepository.listResources()).rejects.toThrow(/disabled/i);

    process.env.GETDONE_RUNTIME_ENV = "production";
    process.env.GETDONE_DATA_MODE = "development-seed";
    await expect(developmentOwnerRepository.listDecisions()).rejects.toThrow(/disabled/i);
  });
});

import { expect, test, type Page } from "@playwright/test";
import {
  createPasskeyFixture,
  installVirtualPasskey,
  resetAndSeedStagingDatabase,
  signInThroughBrowser,
  sql
} from "./helpers";

async function browserJson(
  page: Page,
  path: string,
  input: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
) {
  return page.evaluate(async ({ path, input }) => {
    const response = await fetch(path, {
      method: input.method ?? "GET",
      cache: "no-store",
      headers: {
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...(input.headers ?? {})
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });
    return {
      status: response.status,
      correlationId: response.headers.get("x-correlation-id"),
      body: await response.json().catch(() => null)
    };
  }, { path, input });
}

test.describe("production browser staging acceptance", () => {
  test("sign in → intent → Decision → approve → Task/Job → safe integration → authoritative completion", async ({ page }) => {
    const passkey = createPasskeyFixture();
    await resetAndSeedStagingDatabase(passkey);
    await page.goto("/sign-in");
    await installVirtualPasskey(page, passkey);
    await signInThroughBrowser(page);

    await page.goto("/");
    await page.getByLabel("Message GetDone").fill(
      "Run the safe staging browser acceptance integration"
    );
    const intentResponsePromise = page.waitForResponse((response) =>
      response.url().includes("/api/control/intents")
      && response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Send message" }).click();
    const intentResponse = await intentResponsePromise;
    expect(intentResponse.status()).toBe(202);
    const intentEnvelope = await intentResponse.json() as {
      ok: boolean;
      correlationId: string;
      data: { id: string; correlationId?: string };
    };
    expect(intentEnvelope.ok).toBe(true);
    expect(intentEnvelope.correlationId).toBeTruthy();
    expect(await page.getByRole("status").textContent()).toContain("Accepted by GetDone");

    const acceptanceToken = process.env.GETDONE_STAGING_ACCEPTANCE_TOKEN;
    expect(acceptanceToken).toBeTruthy();
    const materialized = await browserJson(page, "/api/staging/acceptance/decision", {
      method: "POST",
      headers: {
        "x-getdone-staging-acceptance-token": acceptanceToken!
      },
      body: { correlationId: intentEnvelope.correlationId }
    });
    expect(materialized.status).toBe(201);
    expect(materialized.body).toMatchObject({
      ok: true,
      data: {
        correlationId: intentEnvelope.correlationId,
        status: "pending",
        requiresStepUp: false
      }
    });
    const decisionId = (materialized.body as {
      data: { id: string };
    }).data.id;

    await page.goto("/decisions");
    await expect(
      page.getByText("Approve browser acceptance execution")
    ).toBeVisible();

    await page.goto(`/decisions/${encodeURIComponent(decisionId)}`);
    await expect(
      page.getByRole("heading", { name: "Approve browser acceptance execution" })
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Authoritative status:/)).toContainText("approved");

    const executed = await browserJson(page, "/api/staging/acceptance/execute", {
      method: "POST",
      headers: {
        "x-getdone-staging-acceptance-token": acceptanceToken!
      },
      body: { decisionId }
    });
    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({
      ok: true,
      data: {
        correlationId: intentEnvelope.correlationId,
        authoritativeCompletion: true,
        runtimeState: "released",
        providerState: "completed",
        verificationResult: "pass",
        durableOutcome: "succeeded"
      }
    });
    const result = (executed.body as {
      data: { jobId: string; taskId: string };
    }).data;

    const persisted = await sql(
      `SELECT
        (SELECT count(*)::int FROM control_plane_entities
          WHERE entity_type='task' AND id=$1) AS task_count,
        (SELECT count(*)::int FROM control_plane_entities
          WHERE entity_type='job' AND id=$2) AS job_count,
        (SELECT count(*)::int FROM staging_browser_provider_objects
          WHERE job_id=$2) AS provider_count,
        (SELECT count(*)::int FROM business_action_verification_evidence
          WHERE job_id=$2) AS evidence_count`,
      [result.taskId, result.jobId]
    );
    expect(persisted.rows[0]).toEqual({
      task_count: 1,
      job_count: 1,
      provider_count: 1,
      evidence_count: 1
    });

    await page.goto(`/staging/acceptance/${encodeURIComponent(result.jobId)}`);
    await expect(page.getByRole("heading", { name: "Authoritative completion" }))
      .toBeVisible();
    await expect(page.getByTestId("authoritative-completion"))
      .toHaveText("Authoritative completion verified");
    await expect(page.getByTestId("acceptance-runtime-state")).toHaveText("released");
    await expect(page.getByTestId("acceptance-provider-state")).toHaveText("completed");
    await expect(page.getByTestId("acceptance-verification-result")).toHaveText("pass");
    await expect(page.getByTestId("acceptance-correlation-id"))
      .toHaveText(intentEnvelope.correlationId);
  });
});

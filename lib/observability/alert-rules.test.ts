import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateOperationalAlert,
  parseOperationalAlertRules
} from "@/lib/observability/alert-rules";

function loadRules() {
  return parseOperationalAlertRules(JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "config/operational-alert-rules.json"), "utf8")
  ));
}

describe("operational alert rules", () => {
  it("defines every required operational failure mode exactly once", () => {
    const document = loadRules();
    expect(document.rules.map((rule) => rule.id).sort()).toEqual([
      "ai-provider-failure-rate",
      "auth-failure-spike",
      "backup-stale",
      "database-unavailable",
      "dead-letter-count",
      "integration-failure-rate",
      "queue-depth",
      "resource-agent-disconnect",
      "verification-backlog",
      "worker-offline"
    ]);
  });

  it("evaluates warning and critical thresholds deterministically", () => {
    const byId = new Map(loadRules().rules.map((rule) => [rule.id, rule]));
    expect(evaluateOperationalAlert(byId.get("worker-offline")!, 119_999)).toBe("ok");
    expect(evaluateOperationalAlert(byId.get("worker-offline")!, 120_000)).toBe("warning");
    expect(evaluateOperationalAlert(byId.get("worker-offline")!, 300_000)).toBe("critical");

    expect(evaluateOperationalAlert(byId.get("queue-depth")!, 249)).toBe("ok");
    expect(evaluateOperationalAlert(byId.get("queue-depth")!, 250)).toBe("warning");
    expect(evaluateOperationalAlert(byId.get("queue-depth")!, 750)).toBe("critical");

    expect(evaluateOperationalAlert(byId.get("backup-stale")!, 64_799)).toBe("ok");
    expect(evaluateOperationalAlert(byId.get("backup-stale")!, 64_800)).toBe("warning");
    expect(evaluateOperationalAlert(byId.get("backup-stale")!, 86_400)).toBe("critical");

    expect(evaluateOperationalAlert(byId.get("ai-provider-failure-rate")!, 0.099)).toBe("ok");
    expect(evaluateOperationalAlert(byId.get("ai-provider-failure-rate")!, 0.1)).toBe("warning");
    expect(evaluateOperationalAlert(byId.get("ai-provider-failure-rate")!, 0.25)).toBe("critical");

    expect(evaluateOperationalAlert(byId.get("database-unavailable")!, 1)).toBe("ok");
    expect(evaluateOperationalAlert(byId.get("database-unavailable")!, 0)).toBe("critical");
  });
});

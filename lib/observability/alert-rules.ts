import { z } from "zod";

export const OPERATIONAL_ALERT_RULES_VERSION = "1.0.0";

const thresholdSchema = z.object({
  operator: z.enum([">=", "<="]),
  value: z.number().finite()
});

export const operationalAlertRuleSchema = z.object({
  id: z.string().min(1),
  metric: z.string().min(1),
  kind: z.enum(["gauge", "counter-rate", "ratio"]),
  unit: z.string().min(1),
  windowSeconds: z.number().int().positive(),
  warning: thresholdSchema,
  critical: thresholdSchema,
  labels: z.array(z.string().min(1)),
  runbook: z.string().min(1)
});

export const operationalAlertRulesDocumentSchema = z.object({
  schemaVersion: z.literal(OPERATIONAL_ALERT_RULES_VERSION),
  rules: z.array(operationalAlertRuleSchema).length(10)
});

export type OperationalAlertRule = z.infer<typeof operationalAlertRuleSchema>;
export type OperationalAlertState = "ok" | "warning" | "critical";

function breached(value: number, threshold: z.infer<typeof thresholdSchema>) {
  return threshold.operator === ">="
    ? value >= threshold.value
    : value <= threshold.value;
}

export function evaluateOperationalAlert(
  rule: OperationalAlertRule,
  value: number
): OperationalAlertState {
  if (!Number.isFinite(value)) return "critical";
  if (breached(value, rule.critical)) return "critical";
  if (breached(value, rule.warning)) return "warning";
  return "ok";
}

export function parseOperationalAlertRules(value: unknown) {
  const parsed = operationalAlertRulesDocumentSchema.parse(value);
  const ids = new Set<string>();
  const metrics = new Set<string>();
  for (const rule of parsed.rules) {
    if (ids.has(rule.id)) throw new TypeError("Operational alert rule IDs must be unique");
    ids.add(rule.id);
    metrics.add(rule.metric);
  }
  if (metrics.size < 10) {
    throw new TypeError("Each required operational alert must have a distinct machine metric");
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    rules: Object.freeze(parsed.rules.map((rule) => Object.freeze({
      ...rule,
      labels: Object.freeze([...rule.labels])
    })))
  });
}

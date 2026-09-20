import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const policy = JSON.parse(fs.readFileSync(path.join(root, "architecture/coverage-policy.json"), "utf8"));
const failures = [];
const modules = [];
let totalTests = 0;

function countTests(content) {
  const direct = [...content.matchAll(/\b(?:it|test)\s*\(/g)].length;
  const each = [...content.matchAll(/\b(?:it|test)\.each\s*\(/g)].length;
  return direct + each;
}

for (const entry of policy.modules) {
  const sourcePath = path.join(root, entry.source);
  const testPath = path.join(root, entry.test);
  const sourceExists = fs.existsSync(sourcePath);
  const testExists = fs.existsSync(testPath);
  const testCases = testExists ? countTests(fs.readFileSync(testPath, "utf8")) : 0;
  totalTests += testCases;
  const covered = sourceExists && testExists && testCases >= policy.thresholds.minimumTestCasesPerCriticalModule;
  modules.push({ ...entry, sourceExists, testExists, testCases, covered });
  if (entry.critical && !covered) {
    failures.push(`Critical module lacks required test coverage: ${entry.source} -> ${entry.test} (${testCases} cases)`);
  }
}

const coveredCount = modules.filter((entry) => entry.covered).length;
const percent = modules.length === 0 ? 100 : Number(((coveredCount / modules.length) * 100).toFixed(2));
if (percent < policy.thresholds.coveredModulePercent) {
  failures.push(`Control-plane module coverage ${percent}% is below ${policy.thresholds.coveredModulePercent}%`);
}
if (totalTests < policy.thresholds.minimumTotalTestCases) {
  failures.push(`Mapped control-plane test cases ${totalTests} are below minimum ${policy.thresholds.minimumTotalTestCases}`);
}

const report = {
  generatedAt: new Date().toISOString(),
  policySchemaVersion: policy.schemaVersion,
  coveredModulePercent: percent,
  coveredModules: coveredCount,
  totalModules: modules.length,
  mappedTestCases: totalTests,
  modules
};
const outDir = path.join(root, "coverage");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "control-plane-module-coverage.json"), JSON.stringify(report, null, 2) + "\n");

if (failures.length) {
  console.error("GetDone control-plane coverage gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`GetDone control-plane coverage gate passed: ${percent}% modules, ${totalTests} mapped test cases.`);

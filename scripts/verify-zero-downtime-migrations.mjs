import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const policyPath = path.join(root,"config","zero-downtime-migration-policy.json");
const policy = JSON.parse(fs.readFileSync(policyPath,"utf8"));
const migrationDir = path.join(root,"migrations");
const files = fs.readdirSync(migrationDir).filter((name)=>name.endsWith(".sql")).sort();

const failures = [];
const after = policy.enforcedAfterVersion;
const governed = files.filter((name)=>{
  const version = name.split("_",1)[0];
  return version.localeCompare(after) > 0;
});
const entries = new Map((policy.migrations ?? []).map((item)=>[item.file,item]));

for (const file of governed) {
  const relative = "migrations/" + file;
  const entry = entries.get(relative);
  if (!entry) {
    failures.push(`migration ${relative} is not classified by zero-downtime policy`);
    continue;
  }
  const sql = fs.readFileSync(path.join(migrationDir,file),"utf8");
  const destructivePatterns = [
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+COLUMN\b/i,
    /\bDROP\s+INDEX\b/i,
    /\bRENAME\s+(?:COLUMN|TO)\b/i,
    /\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i,
    /\bSET\s+NOT\s+NULL\b/i
  ];
  const destructive = destructivePatterns.some((pattern)=>pattern.test(sql));
  const dropsConstraint = /\bDROP\s+CONSTRAINT\b/i.test(sql);
  const compatibleConstraintWidening = entry.compatibleConstraintWidening === true;
  if (dropsConstraint && compatibleConstraintWidening) {
    const constraint = String(entry.constraintName ?? "").trim();
    if (
      !constraint
      || !sql.includes(`DROP CONSTRAINT IF EXISTS ${constraint}`)
      || !sql.includes(`ADD CONSTRAINT ${constraint}`)
      || !/ADD\s+CONSTRAINT[\s\S]*CHECK[\s\S]*NOT\s+VALID/i.test(sql)
      || !/VALIDATE\s+CONSTRAINT/i.test(sql)
    ) {
      failures.push(`${relative} declared a compatible constraint widening without drop/re-add NOT VALID/VALIDATE evidence`);
    }
  }

  if (entry.phase === "expand" || entry.phase === "migrate") {
    if (destructive || (dropsConstraint && !compatibleConstraintWidening)) {
      failures.push(`${relative} contains destructive SQL in ${entry.phase} phase`);
    }
    if (entry.destructive === true) failures.push(`${relative} is marked destructive in ${entry.phase} phase`);
  }
  if (entry.phase === "contract") {
    if (entry.destructive !== true) failures.push(`${relative} contract migration must explicitly mark destructive=true`);
    for (const key of ["requiresOldFleetDrained","requiresTransitionVerification","requiresFreshBackup"]) {
      if (entry[key] !== true) failures.push(`${relative} contract migration missing ${key}=true`);
    }
    if (!entry.minimumCompatibleRelease) {
      failures.push(`${relative} contract migration must declare minimumCompatibleRelease`);
    }
  }
}

for (const entry of policy.migrations ?? []) {
  if (!files.includes(path.basename(entry.file))) {
    failures.push(`policy references missing migration ${entry.file}`);
  }
  if (!["expand","migrate","contract"].includes(entry.phase)) {
    failures.push(`migration ${entry.file} has invalid phase ${entry.phase}`);
  }
}

if (!/^[a-f0-9]{40}$/.test(policy.previousReleaseRef ?? "")) {
  failures.push("previousReleaseRef must be an exact 40-character commit SHA");
}
if (!Number.isInteger(policy.compatibilityWindowReleases) || policy.compatibilityWindowReleases < 1) {
  failures.push("compatibilityWindowReleases must be at least one release");
}

if (failures.length) {
  console.error(JSON.stringify({ok:false,verifier:"zero-downtime-migrations",failures},null,2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok:true,
  verifier:"zero-downtime-migrations",
  policyId:policy.policyId,
  previousReleaseRef:policy.previousReleaseRef,
  governedMigrations:governed,
  transitionMigrations:(policy.migrations ?? []).filter((item)=>item.transitionSchema).map((item)=>item.version)
},null,2));

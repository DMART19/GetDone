import { describe, expect, it } from "vitest";
import {
 assertIsolatedRestoreAdmin,
 assertStagingBackupSource
} from "../../scripts/staging-backup-target-guard.mjs";

const stage = "postgresql://postgres.ddxjiszbsmmbqxuoecmg:fake-password@aws-1-ca-central-1.pooler.supabase.com:5432/postgres";
const local = "postgresql://postgres:fixture@127.0.0.1:5432/getdone_backup_source_test";
const env = {
 GETDONE_RUNTIME_ENV:"staging", GETDONE_DB_SSL:"true",
 PGSSLMODE:"verify-full", PGSSLROOTCERT:"/private/ca.pem"
};

describe("pre-migration staging backup target safety", () => {
  it("accepts only the exact staging project over verified TLS", () => {
    expect(assertStagingBackupSource(stage,env).fixture).toBe(false);
    expect(assertStagingBackupSource(
      "postgresql://postgres:fake-password@db.ddxjiszbsmmbqxuoecmg.supabase.co:5432/postgres",
      env
    ).fixture).toBe(false);
  });
  it.each([
    ["development",stage,{...env,GETDONE_RUNTIME_ENV:"development"}],
    ["production database",stage.replaceAll("ddxjiszbsmmbqxuoecmg","foreign"),env],
    ["wrong account",stage.replace("postgres.ddxjiszbsmmbqxuoecmg","postgres"),env],
    ["no TLS",stage,{...env,GETDONE_DB_SSL:"false"}],
    ["no CA",stage,{...env,PGSSLROOTCERT:""}],
    ["unverified TLS",stage,{...env,PGSSLMODE:"require"}],
    ["no-verify URL",stage+"?sslmode=no-verify",env],
    ["plaintext URL",stage+"?sslmode=disable",env]
  ])("fails closed: %s", (_name,url,config) => {
    expect(() => assertStagingBackupSource(url,config)).toThrow();
  });
  it("allows isolated local fixtures only when explicitly flagged and precisely named", () => {
    expect(() => assertStagingBackupSource(local,env)).toThrow();
    expect(assertStagingBackupSource(local,{
      ...env,GETDONE_ALLOW_ISOLATED_RESTORE_TEST:"true"
    }).fixture).toBe(true);
    expect(() => assertStagingBackupSource(
      local.replace("getdone_backup_source_test","postgres"),
      {...env,GETDONE_ALLOW_ISOLATED_RESTORE_TEST:"true"}
    )).toThrow();
  });
  it("never accepts a remote or production restore server", () => {
    expect(assertIsolatedRestoreAdmin(
      "postgresql://postgres:fixture@127.0.0.1:5432/postgres",stage
    ).isolated).toBe(true);
    expect(() => assertIsolatedRestoreAdmin(stage,local)).toThrow(/separate local/);
    expect(() => assertIsolatedRestoreAdmin(local,local)).toThrow(/differ/);
  });
});

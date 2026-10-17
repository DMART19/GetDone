import { describe, expect, it } from "vitest";
import {
 assertIsolatedRestoreAdmin,
 assertStagingBackupSource,
 createPostgresCliEnvironment
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
    ["url sslmode require",stage+"?sslmode=require",env],
    ["url sslmode verify-ca",stage+"?sslmode=verify-ca",env],
    ["url sslmode prefer",stage+"?sslmode=prefer",env],
    ["url sslmode allow",stage+"?sslmode=allow",env],
    ["no-verify URL",stage+"?sslmode=no-verify",env],
    ["plaintext URL",stage+"?sslmode=disable",env]
  ])("fails closed: %s", (_name,url,config) => {
    expect(() => assertStagingBackupSource(url,config)).toThrow();
  });
  it("always enforces verify-full for pg_dump and pg_restore, ignoring unsafe inherited libpq connection settings", () => {
    const args = {
      ...env, PGHOSTADDR: "198.51.100.23", PGSERVICE: "untrusted-service"
    };
    const result = createPostgresCliEnvironment(stage,args);
    expect(result.PGSSLMODE).toBe("verify-full");
    expect(result.PGSSLROOTCERT).toBe("/private/ca.pem");
    expect(result.PGHOST).toBe("aws-1-ca-central-1.pooler.supabase.com");
    expect(result.PGHOSTADDR).toBeUndefined();
    expect(result.PGSERVICE).toBeUndefined();
    expect(result.PGUSER).toBe("postgres.ddxjiszbsmmbqxuoecmg");
    expect(result.PGDATABASE).toBe("postgres");

    const restored = createPostgresCliEnvironment(stage,args,"getdone_restore_verify_test");
    expect(restored.PGSSLMODE).toBe("verify-full");
    expect(restored.PGDATABASE).toBe("getdone_restore_verify_test");
    for (const mode of ["require","verify-ca","prefer","allow","disable","no-verify"]) {
      expect(() => createPostgresCliEnvironment(stage+"?sslmode="+mode,args)).toThrow(/downgrade/);
    }
  });

  it("allows explicit no-TLS only for the already-isolated disposable local fixture", () => {
    const localEnv = {
      ...env,GETDONE_DB_SSL:"false",
      GETDONE_ALLOW_ISOLATED_RESTORE_TEST:"true"
    };
    expect(assertStagingBackupSource(local,localEnv).fixture).toBe(true);
    expect(createPostgresCliEnvironment(local,localEnv).PGSSLMODE).toBe("disable");
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

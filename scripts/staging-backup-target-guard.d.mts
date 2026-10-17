export declare const STAGING_PROJECT_ID: "ddxjiszbsmmbqxuoecmg";
export declare function assertStagingBackupSource(
  value: string, env?: Readonly<Record<string,string|undefined>>
): Readonly<{ fixture: boolean }>;
export declare function assertIsolatedRestoreAdmin(
  value: string, sourceValue?: string
): Readonly<{ isolated: true }>;
export declare function createPostgresCliEnvironment(
  value: string, env?: Readonly<Record<string,string|undefined>>, databaseName?: string
): Record<string,string|undefined>;

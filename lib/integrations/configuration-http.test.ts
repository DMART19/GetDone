import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertIntegrationOwnerPrincipal,
  integrationConfigurationActionSchema,
  integrationConfigurationCreateSchema,
  integrationConfigurationUpdateSchema
} from "@/lib/integrations/configuration-http";

describe("integration configuration HTTP safety",()=>{
  it("accepts only owner-safe configuration fields and rejects raw credentials",()=>{
    expect(integrationConfigurationCreateSchema.parse({
      id:"calendar-prod",
      provider:"calendar",
      displayName:"Production Calendar",
      capabilityNames:["calendar.event.read"],
      grantedScopes:["calendar.read"],
      credentialBindingId:"binding:calendar:prod"
    })).toMatchObject({provider:"calendar"});

    for(const rawSecretField of ["token","password","clientSecret","apiKey","credentialMaterial"]){
      expect(()=>integrationConfigurationCreateSchema.parse({
        id:"calendar-prod",
        provider:"calendar",
        displayName:"Production Calendar",
        capabilityNames:["calendar.event.read"],
        grantedScopes:["calendar.read"],
        credentialBindingId:"binding:calendar:prod",
        [rawSecretField]:"secret-value"
      })).toThrow();
    }

    expect(()=>integrationConfigurationCreateSchema.parse({
      id:"calendar-prod",
      provider:"calendar",
      displayName:"Production Calendar",
      capabilityNames:["calendar.event.read"],
      grantedScopes:["calendar.read"],
      companyId:"attacker-company"
    })).toThrow();
    expect(()=>integrationConfigurationCreateSchema.parse({
      id:"calendar-prod",
      provider:"calendar",
      displayName:"Production Calendar",
      capabilityNames:["calendar.event.read"],
      grantedScopes:["calendar.read"],
      environment:"production"
    })).toThrow();
  });

  it("requires optimistic versioning for update and action mutations",()=>{
    expect(()=>integrationConfigurationUpdateSchema.parse({
      displayName:"Changed"
    })).toThrow();
    expect(integrationConfigurationUpdateSchema.parse({
      expectedVersion:2,
      credentialBindingId:null
    })).toEqual({expectedVersion:2,credentialBindingId:null});

    expect(()=>integrationConfigurationActionSchema.parse({
      action:"disable"
    })).toThrow();
    expect(integrationConfigurationActionSchema.parse({
      action:"revoke",
      expectedVersion:4
    })).toEqual({action:"revoke",expectedVersion:4});
  });

  it("enforces owner role and fresh step-up when requested",()=>{
    expect(()=>assertIntegrationOwnerPrincipal({role:"viewer"}))
      .toThrow(/Owner role/i);
    expect(()=>assertIntegrationOwnerPrincipal({role:"owner"},{requireStepUp:true}))
      .toThrow(/step-up/i);
    expect(()=>assertIntegrationOwnerPrincipal({
      role:"owner",
      stepUpProof:{id:"proof"}
    },{requireStepUp:true})).not.toThrow();
  });

  it("renders a UI with broker references only and no secret input fields",()=>{
    const source=fs.readFileSync(
      path.join(process.cwd(),"components/integration-manager.tsx"),
      "utf8"
    );
    expect(source).toContain("Credential binding reference");
    expect(source).toContain("Secret material is redeemed server-side");
    expect(source).not.toMatch(/name=["'](?:token|password|clientSecret|apiKey)["']/i);
    expect(source).not.toMatch(/type=["']password["']/i);
    expect(source).toContain("Company and environment are bound from your authenticated owner session");
  });
});

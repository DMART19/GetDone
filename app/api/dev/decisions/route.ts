import { NextResponse } from "next/server";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import { requireDevelopmentApiRuntime } from "@/lib/control-plane/runtime-environment.server";
import { apiSuccess } from "@/lib/control-plane/schemas";
import { developmentOwnerRepository } from "@/lib/data/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const environment = requireDevelopmentApiRuntime();
    const correlationId = createCorrelationId();
    const data = await developmentOwnerRepository.listDecisions();

    return NextResponse.json(apiSuccess([...data], { correlationId, environment }));
  } catch {
    return NextResponse.json({ code: "NOT_FOUND" }, { status: 404 });
  }
}

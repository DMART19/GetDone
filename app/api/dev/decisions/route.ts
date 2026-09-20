import { NextResponse } from "next/server";
import { createCorrelationId, parseEnvironment } from "@/lib/control-plane/request-context";
import { apiSuccess } from "@/lib/control-plane/schemas";
import { developmentOwnerRepository } from "@/lib/data/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  const environment = parseEnvironment(process.env.NEXT_PUBLIC_APP_ENV);
  if (environment === "production") {
    return NextResponse.json({ code: "DEVELOPMENT_DATA_DISABLED" }, { status: 404 });
  }

  const correlationId = createCorrelationId();
  const data = await developmentOwnerRepository.listDecisions();

  return NextResponse.json(apiSuccess([...data], { correlationId, environment }));
}

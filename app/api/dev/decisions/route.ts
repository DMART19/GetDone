import { NextResponse } from "next/server";
import { decisions } from "@/lib/mock-data";

export const dynamic = "force-dynamic";

export function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ code: "DEVELOPMENT_DATA_DISABLED" }, { status: 404 });
  }
  return NextResponse.json({ source: "development-seed", authoritative: false, data: decisions });
}

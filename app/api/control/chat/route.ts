import { handleOwnerIntent, handleOwnerIntentHistory } from "@/lib/control-api/http";

export const dynamic = "force-dynamic";
export const POST = handleOwnerIntent;
export const GET = handleOwnerIntentHistory;

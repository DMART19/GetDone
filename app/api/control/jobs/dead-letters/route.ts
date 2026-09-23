import { handleListDeadLetters } from "@/lib/execution/dead-letter-operator-http.server";

export const dynamic = "force-dynamic";
export const GET = handleListDeadLetters;

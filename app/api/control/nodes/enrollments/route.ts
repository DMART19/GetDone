import {
  handleCreateNodeEnrollment,
  handleListNodeEnrollments
} from "@/lib/nodes/http";

export const dynamic = "force-dynamic";
export const GET = handleListNodeEnrollments;
export const POST = handleCreateNodeEnrollment;

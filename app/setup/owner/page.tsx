import { AppShell } from "@/components/app-shell";
import { OwnerEnrollment } from "@/components/owner-enrollment";
export const dynamic = "force-dynamic";
export default function OwnerSetupPage() {
  return <AppShell navigation={false}><div className="sign-in-page"><OwnerEnrollment /></div></AppShell>;
}

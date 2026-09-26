import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DevelopmentBadge } from "@/components/dev-badge";
import {
  readProductionAcceptanceSurfaceReport
} from "@/lib/release/production-acceptance-surface.server";

export const dynamic = "force-dynamic";

function when(value: string | null) {
  return value ? new Date(value).toLocaleString() : "No live evidence";
}

export default function ProductionAcceptancePage() {
  const report = readProductionAcceptanceSurfaceReport();
  const deployment = report.softwareDeploymentAcceptance;

  return (
    <AppShell navigation={false}>
      <BackHeader title="Production Acceptance" href="/" />
      <DevelopmentBadge />
      <section className="page-content">
        <div className="title-row">
          <div>
            <h1>Production acceptance</h1>
            <p>
              Evidence-backed deployment, rollback, connectivity, and promotion
              state.
            </p>
          </div>
        </div>

        <article className="detail-card">
          <span>Production promotion</span>
          <h2
            className={
              report.eligibleForProductionPromotion ? "good-text" : undefined
            }
          >
            {report.eligibleForProductionPromotion
              ? "Eligible for owner approval"
              : "Blocked"}
          </h2>
          <p>
            Provider deployment acceptance never proves success by itself. The
            gate requires independent live evidence and keeps the existing
            owner promotion approval boundary.
          </p>
          <div className="info-list">
            <div>
              <span>Report generated</span>
              <strong>{when(report.generatedAt)}</strong>
            </div>
            <div>
              <span>Last live test</span>
              <strong>{when(report.lastLiveTestedAt)}</strong>
            </div>
          </div>
        </article>

        <article className="detail-card">
          <span>Live staging deployment and rollback</span>
          {deployment ? (
            <>
              <h2>{deployment.status}</h2>
              <div className="info-list">
                <div>
                  <span>Provider / target</span>
                  <strong>{deployment.provider} / {deployment.target}</strong>
                </div>
                <div>
                  <span>Bad deploy caught</span>
                  <strong>
                    {deployment.failedVerificationDetected ? "Yes" : "No"}
                  </strong>
                </div>
                <div>
                  <span>Recovery verified</span>
                  <strong>{deployment.recoveryVerified ? "Yes" : "No"}</strong>
                </div>
                <div>
                  <span>Known good</span>
                  <strong className="mono">
                    {deployment.goodDeploymentReference ?? "Unavailable"}
                  </strong>
                </div>
                <div>
                  <span>Controlled bad</span>
                  <strong className="mono">
                    {deployment.badDeploymentReference ?? "Unavailable"}
                  </strong>
                </div>
                <div>
                  <span>Rolled back to</span>
                  <strong className="mono">
                    {deployment.rollbackToDeploymentReference ?? "Unavailable"}
                  </strong>
                </div>
                <div>
                  <span>Lineage</span>
                  <strong className="mono">
                    {deployment.lineageHash ?? "Unavailable"}
                  </strong>
                </div>
              </div>
            </>
          ) : (
            <p>
              No persisted live deployment/rollback acceptance is present in
              this runtime.
            </p>
          )}
        </article>

        <article className="detail-card">
          <span>Connected</span>
          {report.connected.length ? (
            <ul>
              {report.connected.map((item) => (
                <li key={item.component}>
                  <strong>{item.component}</strong> — {item.status}
                </li>
              ))}
            </ul>
          ) : (
            <p>No production connection is currently proven by this report.</p>
          )}
        </article>

        <article className="detail-card">
          <span>Tested live</span>
          {report.testedLive.length ? (
            <ul>
              {report.testedLive.map((item) => (
                <li key={item.evidencePath}>
                  <strong>{item.area}</strong> — {item.status} ·{" "}
                  {when(item.lastTestedAt)}
                </li>
              ))}
            </ul>
          ) : (
            <p>No live acceptance evidence is available in this runtime report.</p>
          )}
        </article>

        <article className="detail-card">
          <span>Remaining blockers</span>
          {report.blocked.length ? (
            <ul>
              {report.blocked.map((item) => (
                <li key={item.component}>
                  <strong>{item.component}</strong> — {item.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="good-text">
              No production acceptance blockers remain.
            </p>
          )}
        </article>
      </section>
    </AppShell>
  );
}

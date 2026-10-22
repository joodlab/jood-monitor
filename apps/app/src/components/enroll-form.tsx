import type { ClusterView } from "@jood-monitor/api-client";
import { useEffect, useState } from "react";
import type { Enrollment } from "../lib/install-enrollment";
import { ConnectDetails } from "./connect-details";
import { ConnectInstall } from "./connect-install";
import { ConnectSteps } from "./connect-parts";
import { ConnectRecover } from "./connect-recover";
import { ConnectWaiting, useFirstDelivery } from "./connect-waiting";

type Cluster = ClusterView["cluster"];
type Step = "install" | "waiting";

// Guided connection: details (or the cluster to renew), install commands
// with the one-time token, then the first heartbeat. The token lives only in
// this component's state and disappears when the dialog closes.
export function EnrollForm({
  clusters,
  workspace,
}: {
  clusters: Cluster[];
  workspace: string;
}) {
  const [mode, setMode] = useState<"new" | "recover">("new");
  const [recoverTarget, setRecoverTarget] = useState<
    Cluster | { id: string }
  >();
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [step, setStep] = useState<Step>("install");
  const [waitingSince, setWaitingSince] = useState(0);
  const delivery = useFirstDelivery(enrollment);
  const arrived = delivery.state !== "waiting";
  useEffect(() => {
    if (arrived) {
      setStep("waiting");
      setWaitingSince((value) => value || Date.now());
    }
  }, [arrived]);
  function enrolled(next: Enrollment) {
    setEnrollment(next);
    setStep("install");
    setWaitingSince(0);
  }
  function recover(target?: Cluster | { id: string }) {
    setEnrollment(undefined);
    setRecoverTarget(target);
    setMode("recover");
  }
  function restart() {
    setEnrollment(undefined);
    setRecoverTarget(undefined);
    setMode("new");
  }
  let current = 0;
  if (enrollment) {
    current = step === "install" ? 1 : 2;
  }
  return (
    <div className="-mx-1 max-h-[min(70vh,44rem)] space-y-5 overflow-y-auto px-1 pb-1">
      <ConnectSteps
        current={current}
        steps={[
          mode === "new" ? "Details" : "Choose cluster",
          "Install",
          "First heartbeat",
        ]}
      />
      {!enrollment && mode === "new" && (
        <ConnectDetails
          clusters={clusters}
          onEnrolled={enrolled}
          onRecover={(id) => recover(id ? { id } : undefined)}
          workspace={workspace}
        />
      )}
      {!enrollment && mode === "recover" && (
        <ConnectRecover
          clusters={clusters}
          initial={recoverTarget}
          key={recoverTarget?.id ?? ""}
          onNewCluster={restart}
          onRenewed={enrolled}
        />
      )}
      {enrollment && step === "install" && (
        <ConnectInstall
          enrollment={enrollment}
          onContinue={() => {
            setStep("waiting");
            setWaitingSince(Date.now());
          }}
          onRenew={() => recover(enrollment.cluster)}
        />
      )}
      {enrollment && step === "waiting" && (
        <ConnectWaiting
          delivery={delivery}
          enrollment={enrollment}
          onAnother={restart}
          onBack={() => setStep("install")}
          onRenew={() => recover(enrollment.cluster)}
          waitingSince={waitingSince}
        />
      )}
    </div>
  );
}

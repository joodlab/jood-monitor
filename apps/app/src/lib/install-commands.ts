// Install commands for a new or renewed cluster, following the Go agents
// enrollment guide (/docs/agents#enrollment) and the chart's default value
// names in deploy/helm/jood-monitor/values.yaml. The enrollment token never
// appears in a command: it is pasted into a private file the helper reads.

export const observerNamespace = "jood-monitor";
const tokenFile = "enrollment-token.txt";
const credentialFile = "hub-credential.txt";

const httpsOrigin = /^https:\/\/[^/]+$/;

// The chart's hubURL schema and the enrollment helper require an exact HTTPS
// origin without a path.
export function hubOriginProblem(origin: string) {
  if (httpsOrigin.test(origin)) {
    return;
  }
  return `This hub is open at ${origin}. The observer and the enrollment helper require the hub's exact HTTPS origin, so replace the placeholder in the commands below.`;
}

export interface InstallStep {
  command: string;
  detail: string;
  id: string;
  title: string;
}

function credentialStep(hub: string, clusterId: string): InstallStep {
  return {
    id: "credential",
    title: "Exchange the token for a scoped credential",
    detail:
      "Run from a checkout of this repository. Paste the token into the private file, press Enter, then Ctrl-D, so it never enters shell history. The helper saves the credential privately and refuses to overwrite an existing one.",
    command: [
      `(umask 077; cat > ${tokenFile})`,
      `chmod 600 ${tokenFile}`,
      `python scripts/enroll-agent.py ${hub} ${clusterId} ${tokenFile} ${credentialFile}`,
    ].join("\n"),
  };
}

function secretsStep(namespace: string): InstallStep {
  return {
    id: "secrets",
    title: "Store the credential and observer TLS in Kubernetes",
    detail: `The observer certificate must be valid for jood-monitor-observer.${namespace}.svc; node collectors verify it with the CA. Replace the certificate file names with your own.`,
    command: [
      `kubectl create namespace ${namespace}`,
      `kubectl -n ${namespace} create secret generic jood-monitor-hub --from-file=credential=${credentialFile}`,
      `kubectl -n ${namespace} create secret tls jood-monitor-observer-tls --cert=observer.crt --key=observer.key`,
      `kubectl -n ${namespace} create configmap jood-monitor-observer-ca --from-file=ca.crt=observer-ca.crt`,
    ].join("\n"),
  };
}

function chartStep(hub: string, namespace: string): InstallStep {
  return {
    id: "chart",
    title: "Install the chart",
    detail:
      "The chart requires an immutable, reviewed agent image digest. Review its RBAC, placement, resource budgets and network policy for your environment first.",
    command: [
      "helm upgrade --install jood-monitor deploy/helm/jood-monitor \\",
      `  --namespace ${namespace} \\`,
      `  --set hubURL=${hub} \\`,
      "  --set image.digest=sha256:<reviewed-agent-digest>",
    ].join("\n"),
  };
}

// A renewed enrollment replaces the stored credential in place. The observer
// reads the mounted file for each request, so its Pod and spool keep running.
function replaceStep(namespace: string): InstallStep {
  return {
    id: "replace",
    title: "Replace the stored credential",
    detail:
      "Updates the existing Secret in place. Kubernetes refreshes the mounted file within about a minute and the observer reads it for each request, so no restart is needed. Restarting the observer would discard pending batches held in its emptyDir spool.",
    command: [
      `kubectl -n ${namespace} create secret generic jood-monitor-hub \\`,
      `  --from-file=credential=${credentialFile} \\`,
      "  --dry-run=client -o yaml | kubectl apply -f -",
    ].join("\n"),
  };
}

export function installSteps({
  origin,
  clusterId,
  kind = "new",
  namespace = observerNamespace,
}: {
  origin: string;
  clusterId: string;
  kind?: "new" | "recover";
  namespace?: string;
}): InstallStep[] {
  const hub = httpsOrigin.test(origin) ? origin : "https://<hub-origin>";
  if (kind === "recover") {
    return [credentialStep(hub, clusterId), replaceStep(namespace)];
  }
  return [
    credentialStep(hub, clusterId),
    secretsStep(namespace),
    chartStep(hub, namespace),
  ];
}

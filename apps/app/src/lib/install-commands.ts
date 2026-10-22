// Install commands for a new or renewed cluster, following the Go agents
// enrollment guide (/docs/agents#enrollment) and the chart's default value
// names in deploy/helm/jood-monitor/values.yaml. The enrollment token never
// appears in a command: it is typed at a silent prompt into a private file.

export const observerNamespace = "jood-monitor";
// The chart's default credentialSecret, observerTLSSecret and
// observerCAConfigMap values.
export const credentialSecret = "jood-monitor-hub";
const observerTLSSecret = "jood-monitor-observer-tls";
const observerCAConfigMap = "jood-monitor-observer-ca";

// Private files written in the checkout. Their names match the repository's
// ".secrets.*" ignore rule, and each is removed only after the step that
// consumes it succeeds.
export const tokenFile = ".secrets.enrollment-token";

type EnrollmentKind = "new" | "recover";

// A renewal writes its own file, so a credential left from the original
// install never blocks the helper.
export function credentialFile(clusterId: string, kind: EnrollmentKind) {
  const file = `.secrets.hub-credential-${clusterId}`;
  return kind === "recover" ? `${file}-renewed` : file;
}

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

// Reads stdin, so it must stay alone on one line: a shell without bracketed
// paste would otherwise feed the following commands into the token file.
function tokenStep(): InstallStep {
  return {
    id: "token",
    title: "Save the enrollment token privately",
    detail: `Run from a checkout of this repository in bash or zsh. Paste the token at the prompt and press Enter; it is not echoed and never enters shell history. ${tokenFile} matches the repository's .secrets.* ignore rule.`,
    command: `(umask 077; printf 'Paste the enrollment token, then press Enter: ' >&2; IFS= read -rs token && printf '%s\\n' "$token" > ${tokenFile}); echo`,
  };
}

function credentialStep(
  hub: string,
  clusterId: string,
  kind: EnrollmentKind
): InstallStep {
  const file = credentialFile(clusterId, kind);
  const renewal =
    kind === "recover"
      ? ` A renewal writes a separate file, so a credential file left from the original install does not block the helper. If ${file} remains from an earlier attempt, move it aside first.`
      : "";
  return {
    id: "credential",
    title: "Exchange the token for a scoped credential",
    detail: `Requires Python 3. The helper saves the credential privately in ${file}, prints “Scoped credential saved privately” and refuses to overwrite an existing file. The token file is removed only after a successful exchange.${renewal}`,
    command: [
      `chmod 600 ${tokenFile}`,
      `python3 scripts/enroll-agent.py ${hub} ${clusterId} ${tokenFile} ${file} && rm -f ${tokenFile}`,
    ].join("\n"),
  };
}

function secretsStep(namespace: string, file: string): InstallStep {
  return {
    id: "secrets",
    title: "Store the credential and observer TLS in Kubernetes",
    detail: `The credential file is removed once the Secret exists, so the Secret becomes its only stored copy. The observer certificate must be valid for jood-monitor-observer.${namespace}.svc; node collectors verify it with the CA. Replace the certificate file names with your own, kept outside this checkout.`,
    command: [
      `kubectl create namespace ${namespace}`,
      `kubectl -n ${namespace} create secret generic ${credentialSecret} --from-file=credential=${file} && rm -f ${file}`,
      `kubectl -n ${namespace} create secret tls ${observerTLSSecret} --cert=observer.crt --key=observer.key`,
      `kubectl -n ${namespace} create configmap ${observerCAConfigMap} --from-file=ca.crt=observer-ca.crt`,
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
// The pipeline's status is kubectl apply's, so the file stays if it fails.
function replaceStep(namespace: string, file: string): InstallStep {
  return {
    id: "replace",
    title: "Replace the stored credential",
    detail:
      "Updates the existing Secret in place and removes the credential file once it is applied, so the Secret stays its only stored copy. Kubernetes refreshes the mounted file within about a minute and the observer reads it for each request, so no restart is needed. Restarting the observer would discard pending batches held in its emptyDir spool.",
    command: [
      `kubectl -n ${namespace} create secret generic ${credentialSecret} \\`,
      `  --from-file=credential=${file} \\`,
      `  --dry-run=client -o yaml | kubectl apply -f - && rm -f ${file}`,
    ].join("\n"),
  };
}

// `kind` names the files; `fullInstall` adds the Secret, TLS and chart steps
// that a renewal of an already installed observer does not need.
export function installSteps({
  origin,
  clusterId,
  kind = "new",
  fullInstall = kind === "new",
  namespace = observerNamespace,
}: {
  origin: string;
  clusterId: string;
  kind?: EnrollmentKind;
  fullInstall?: boolean;
  namespace?: string;
}): InstallStep[] {
  const hub = httpsOrigin.test(origin) ? origin : "https://<hub-origin>";
  const file = credentialFile(clusterId, kind);
  const exchange = [tokenStep(), credentialStep(hub, clusterId, kind)];
  if (!fullInstall) {
    return [...exchange, replaceStep(namespace, file)];
  }
  return [...exchange, secretsStep(namespace, file), chartStep(hub, namespace)];
}

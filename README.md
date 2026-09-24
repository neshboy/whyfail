# Whyfail

**Whyfail** is a Kubernetes troubleshooting CLI. Point it at a namespace (or
feed it exported diagnostic JSON) and it correlates pod status, container
states, and recent events into a single plain-English "here's why this pod is
failing" explanation - instead of you manually cross-referencing
`kubectl get pods`, `kubectl describe pod`, and `kubectl get events`.

Whyfail is rule-based: it pattern-matches real, documented Kubernetes API
fields (`containerStatuses[].state.waiting.reason`, exit codes, event
reasons/messages, ...) against a fixed set of known failure signatures. It
does not call an LLM and it does not guess. If nothing matches, it says so.

## What it does

For each pod, Whyfail looks at:

- `pod.status.phase` and `pod.status.conditions[]` (e.g. `Ready=False`)
- `containerStatuses[].state` / `.lastState` - `waiting.reason`,
  `terminated.exitCode`, `terminated.reason`, `restartCount`
- the `Event` objects involving that pod - `reason`, `message`, `type`

...and runs them through a rule engine that currently covers 12 distinct,
specific failure modes (see [Diagnosis rules](#diagnosis-rules) below). Each
rule looks for a *combination* of signals, so it can tell apart failures that
look superficially identical - e.g. two pods stuck in `ImagePullBackOff` get
different diagnoses depending on whether the associated event says
`manifest unknown` (bad tag) or `no basic auth credentials` (missing
imagePullSecret).

## Install / quick start

```bash
git clone <this-repo>
cd whyfail
npm install
npm run build
```

### Mode 1: offline, from exported JSON (works everywhere, no cluster needed)

This is the easiest way to try Whyfail and how its test suite works. Export
real (or fixture) diagnostics from any cluster:

```bash
kubectl get pods -n my-namespace -o json > pods.json
kubectl get events -n my-namespace -o json > events.json
```

Then analyze them offline, any time, on any machine:

```bash
node dist/cli.js --from-file pods.json events.json
```

You can try this immediately with one of the bundled test fixtures, no
cluster or export step required:

```bash
node dist/cli.js --from-file test/fixtures/oom-killed/pods.json test/fixtures/oom-killed/events.json
```

### Mode 2: live cluster

If `kubectl` is on your `PATH` and configured against a reachable cluster,
Whyfail will shell out to it directly (`kubectl get pods/events -n <ns> -o
json`, invoked as an argv array - never via a shell string):

```bash
node dist/cli.js -n my-namespace
# or, once linked/installed as a bin:
whyfail -n my-namespace
```

If `kubectl` isn't installed or no cluster is reachable, Whyfail fails
honestly with a message telling you to use `--from-file` instead - it never
fabricates pod data.

## Example output

Running `node dist/cli.js --from-file test/fixtures/oom-killed/pods.json test/fixtures/oom-killed/events.json`:

```
Whyfail report
==============

[ISSUE] Pod: cache-worker-7d9f8c-abcde  (phase: Running)
    - container cache-worker: waiting: CrashLoopBackOff, ready=false, restarts=6
    Diagnosis: Container "cache-worker" is being OOMKilled (exit code 137) - it exceeded its memory limit.
    Kubernetes killed the container after it used more memory than its configured limit (restartCount=6). Raise the container's memory limit/request, or investigate a memory leak / undersized limit in the application.

--------------
Summary: 1 pod(s) - 0 healthy, 1 diagnosed, 0 inconclusive.
```

And for a failure Whyfail's rules don't recognize (fixture:
`test/fixtures/inconclusive`), it says so instead of guessing:

```
[?] Pod: custom-agent-8h9i0-net01  (phase: Pending)
    - container custom-agent: waiting: ContainerCreating, ready=false, restarts=0
    Diagnosis: Inconclusive - no known failure pattern matched this pod. Here is the raw signal for manual review:
    phase=Pending
    container custom-agent: waiting: ContainerCreating, restarts=0, ready=false
    condition Initialized=False
    condition Ready=False (ContainersNotReady)
    event[Warning] FailedCreatePodSandBox: Failed to create pod sandbox: rpc error: ... failed to find plugin "calico" in path [/opt/cni/bin]
```

## Diagnosis rules

Twelve distinct, hand-reasoned rules, each requiring a specific *combination*
of container-state and event signal (checked roughly in this priority order,
most specific first):

| Rule ID | Trigger | Diagnosis |
|---|---|---|
| `oom-killed` | any container's current/last `terminated.reason == "OOMKilled"` | Killed for exceeding its memory limit |
| `crashloop-sigterm` | `waiting.reason == "CrashLoopBackOff"` + last exit code `143` | Repeated SIGTERM - failed liveness probe or slow shutdown |
| `crashloop-generic` | `waiting.reason == "CrashLoopBackOff"` (any other exit code) | Application process is crashing on its own |
| `imagepull-manifest-unknown` | `ImagePullBackOff`/`ErrImagePull` + event `Failed` mentioning `manifest unknown`/`not found` | Image tag doesn't exist in the registry |
| `imagepull-auth` | `ImagePullBackOff`/`ErrImagePull` + event mentioning `no basic auth credentials`/`unauthorized`/`pull access denied` | Cluster can't authenticate to a private registry |
| `config-configmap-missing` | `CreateContainerConfigError` mentioning `configmap` | Referenced ConfigMap doesn't exist |
| `config-secret-missing` | `CreateContainerConfigError` mentioning `secret` | Referenced Secret doesn't exist |
| `readiness-probe-failing` | event `Unhealthy` mentioning `Readiness probe failed` | Container up but not receiving traffic |
| `liveness-probe-restart` | event `Unhealthy`/`Killing` mentioning `Liveness probe failed` | Restarted for failing its liveness probe |
| `pvc-unbound` | event `FailedScheduling`/`FailedMount`/`FailedAttachVolume` mentioning `persistentvolumeclaim` | A PVC the pod needs isn't bound |
| `insufficient-resources` | event `FailedScheduling` mentioning `Insufficient cpu`/`Insufficient memory` | No node has enough free CPU/memory |
| `unschedulable-node-affinity` | event `FailedScheduling` mentioning node affinity/selector/taint mismatch | No node satisfies the pod's placement rules |

A pod that is `Running`/`Succeeded`, `Ready`, and has no `Warning` events is
reported as healthy without running the rule engine at all. If a pod is
unhealthy but matches none of the rules above, Whyfail reports **inconclusive**
and dumps the raw phase/condition/container-state/event signal instead of
guessing.

## Testing

```bash
npm test
```

This runs `tsc` (via `pretest`) and then the full Vitest suite. The suite
uses 14 hand-built fixture pairs under `test/fixtures/<case>/{pods,events}.json`,
shaped exactly like real `kubectl get pods -o json` / `kubectl get events -o
json` output - one pair per diagnosis rule, plus one pod that intentionally
matches no rule (a `FailedCreatePodSandBox` CNI plugin error) to verify the
honest "inconclusive" fallback, plus one fully healthy pod. It also spawns
the actually-built `dist/cli.js` as a real subprocess to verify the shipped
binary works end-to-end, and exercises the live-cluster code path against
whatever `kubectl` context happens to be configured on the test machine
(tolerating either a real result or an honest failure).

## Limitations

- **Rule-based, not exhaustive.** Whyfail currently ships 12 diagnosis rules
  covering common real-world failure modes. Kubernetes has many more ways to
  fail than that. Anything not covered lands in the honest "inconclusive"
  bucket rather than a rule stretched to fit.
- **The "inconclusive" fallback is a deliberate feature, not a bug.** When no
  rule's specific signal combination is present, Whyfail will never invent a
  confident-sounding diagnosis - it shows you the raw phase/condition/state/
  event data instead so you can reason about it yourself. A wrong confident
  guess is worse than no guess.
- **No historical/log analysis.** Whyfail only looks at the current
  `PodStatus` snapshot and recent `Event` objects; it does not read container
  logs or historical metrics (e.g. it won't itself confirm a memory leak,
  just that OOMKilled happened).
- **Event-dependent.** Some diagnoses (image pull auth vs. missing tag, PVC
  binding, scheduling failures) rely on the Kubernetes event that explains
  *why*. If that event has already scrolled out of the cluster's event
  retention window, Whyfail falls back to a more generic rule or to
  inconclusive.
- **Single namespace per run.** Live mode analyzes one namespace at a time
  (matching `kubectl -n <namespace>` semantics).

## License

MIT - see [LICENSE](LICENSE).

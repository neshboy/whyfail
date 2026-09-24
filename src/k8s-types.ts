/**
 * Minimal, real Kubernetes API object shapes - only the fields Whyfail
 * actually reads. These mirror the documented structures produced by
 * `kubectl get pods -o json` and `kubectl get events -o json`
 * (see https://kubernetes.io/docs/reference/generated/kubernetes-api/).
 */

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string>;
}

export interface PodCondition {
  type: string; // e.g. "PodScheduled" | "Initialized" | "ContainersReady" | "Ready"
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface ContainerStateWaiting {
  reason?: string; // e.g. "CrashLoopBackOff" | "ImagePullBackOff" | "CreateContainerConfigError"
  message?: string;
}

export interface ContainerStateRunning {
  startedAt?: string;
}

export interface ContainerStateTerminated {
  exitCode: number;
  reason?: string; // e.g. "Error" | "OOMKilled" | "Completed"
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  signal?: number;
}

export interface ContainerState {
  waiting?: ContainerStateWaiting;
  running?: ContainerStateRunning;
  terminated?: ContainerStateTerminated;
}

export interface ContainerStatus {
  name: string;
  image?: string;
  imageID?: string;
  ready: boolean;
  restartCount: number;
  state?: ContainerState;
  lastState?: ContainerState;
}

export interface PodStatus {
  phase?: string; // "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown"
  conditions?: PodCondition[];
  containerStatuses?: ContainerStatus[];
  initContainerStatuses?: ContainerStatus[];
  message?: string;
  reason?: string;
}

export interface PodSpec {
  containers?: { name: string; image?: string }[];
  volumes?: unknown[];
  nodeName?: string;
}

export interface Pod {
  kind?: string;
  metadata: ObjectMeta;
  spec?: PodSpec;
  status?: PodStatus;
}

export interface PodList {
  kind?: string;
  items: Pod[];
}

export interface InvolvedObject {
  kind?: string;
  name?: string;
  namespace?: string;
  uid?: string;
}

export interface K8sEvent {
  metadata?: ObjectMeta;
  involvedObject: InvolvedObject;
  reason?: string; // e.g. "Failed" | "BackOff" | "FailedScheduling" | "Unhealthy" | "FailedMount"
  message?: string;
  type?: string; // "Normal" | "Warning"
  firstTimestamp?: string;
  lastTimestamp?: string;
  count?: number;
  source?: { component?: string };
}

export interface EventList {
  kind?: string;
  items: K8sEvent[];
}

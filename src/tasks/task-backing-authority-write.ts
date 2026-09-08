import { inspectDefaultSubagentTaskBacking } from "./detached-task-runtime.js";
import { isProvisionalSubagentKillTask } from "./task-cancellation-state.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import type { JsonValue, TaskRecord, TaskRuntime } from "./task-registry.types.js";

type CanonicalTaskBacking = {
  runtime: TaskRuntime;
  ownerKey: string;
  childSessionKey: string;
  runId: string;
  generation: number | undefined;
  detail: JsonValue;
};

function findCanonicalTaskBacking(params: CanonicalTaskBacking): TaskRecord | undefined {
  const backing = inspectDefaultSubagentTaskBacking({
    runId: params.runId,
    ownerKey: params.ownerKey,
    sessionKey: params.childSessionKey,
    generation: params.generation,
    policy: "failure-finalization",
  });
  return backing.kind === "valid" && backing.task.runtime === params.runtime
    ? backing.task
    : undefined;
}

export type PreparedCanonicalTaskActivation = {
  current: TaskRecord;
  next: TaskRecord;
};

/** Prepares the task half of an atomic replacement without publishing it early. */
export function prepareCanonicalTaskActivation(
  params: CanonicalTaskBacking & {
    startedAt: number;
    preserveProvisionalCancellation?: boolean;
  },
): PreparedCanonicalTaskActivation | undefined {
  const current = findCanonicalTaskBacking(params);
  if (!current) {
    return undefined;
  }
  const next = cloneTaskRecord(current);
  next.detail = structuredClone(params.detail);
  if (
    current.status === "succeeded" ||
    (current.status === "cancelled" &&
      (!isProvisionalSubagentKillTask(current) || params.preserveProvisionalCancellation === true))
  ) {
    return { current, next };
  }
  next.status = "running";
  next.startedAt = current.startedAt ?? params.startedAt;
  next.lastEventAt = params.startedAt;
  // Silent collectors never enter the delivery queue when their owner generation changes.
  next.deliveryStatus = current.deliveryStatus === "not_applicable" ? "not_applicable" : "pending";
  delete next.endedAt;
  delete next.cleanupAfter;
  delete next.error;
  delete next.progressSummary;
  delete next.terminalSummary;
  delete next.terminalOutcome;
  return { current, next };
}

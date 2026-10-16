// Answers ACP session/request_permission by rule (PRD AI-6) and records every decision (TM-001 detection).
import { readFileSync } from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";

export interface Policy {
  name: string;
  default: "allow" | "reject";
  allowKinds?: string[];
  allowTitleRegex?: string[];
}
export interface Decision {
  ts: string;
  tool: string;
  kind?: string;
  rawInput?: unknown;
  verdict: "allow" | "reject";
  chosenOption?: string;
  reason: string;
}

export const loadPolicy = (file: string): Policy => JSON.parse(readFileSync(file, "utf8"));

export function decide(policy: Policy, req: acp.RequestPermissionRequest): { response: acp.RequestPermissionResponse; decision: Decision } {
  const tc = req.toolCall as any;
  const title = String(tc.title ?? "");
  const kind = tc.kind as string | undefined;
  let verdict: "allow" | "reject" = policy.default;
  let reason = `default:${policy.default}`;
  if (kind && policy.allowKinds?.includes(kind)) ((verdict = "allow"), (reason = `kind:${kind}`));
  for (const re of policy.allowTitleRegex ?? []) {
    if (new RegExp(re, "i").test(title)) ((verdict = "allow"), (reason = `title~/${re}/`));
  }
  const want = verdict === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const opt = req.options.find((o) => want.includes(o.kind)) ?? (verdict === "allow" ? undefined : req.options[req.options.length - 1]);
  const decision: Decision = { ts: new Date().toISOString(), tool: title, kind, rawInput: tc.rawInput, verdict, chosenOption: opt?.optionId, reason };
  const response: acp.RequestPermissionResponse = opt
    ? { outcome: { outcome: "selected", optionId: opt.optionId } }
    : { outcome: { outcome: "cancelled" } };
  return { response, decision };
}

// Tiny JSONL logger shared by the spike's servers. One line per event so the
// escape tests can grep/assert on the audit trail.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function makeLogger(component: string, file?: string) {
  if (file) mkdirSync(dirname(file), { recursive: true });
  return (event: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), component, event, ...fields });
    console.log(line);
    if (file) {
      try {
        appendFileSync(file, line + "\n");
      } catch {
        /* log dir may be read-only in some profiles; stdout still has it */
      }
    }
  };
}

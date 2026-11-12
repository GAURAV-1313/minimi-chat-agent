// Holds a speculative writer's events back until the planner decides whether to keep them.
// release(): replay everything held, in order, then pass later events straight through.
// discard(): drop everything, including anything that arrives later (the speculative call is being aborted).
import type { AgentEvent } from "./answer.ts";

export class Gate {
  private held: AgentEvent[] = [];
  private state: "holding" | "open" | "closed" = "holding";

  constructor(private out: (e: AgentEvent) => void) {}

  readonly emit = (e: AgentEvent): void => {
    if (this.state === "open") this.out(e);
    else if (this.state === "holding") this.held.push(e);
  };

  release(): void {
    if (this.state !== "holding") return;
    this.state = "open";
    const held = this.held;
    this.held = [];
    for (const e of held) this.out(e);
  }

  discard(): void {
    this.state = "closed";
    this.held = [];
  }

  get heldCount(): number {
    return this.held.length;
  }
}

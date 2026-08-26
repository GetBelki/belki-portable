import { parseCrontab } from "graphile-worker";
import { describe, expect, it } from "vitest";
import { taskList, workerCrontab } from "../src/portable/jobs/tasks";

describe("portable worker registry", () => {
  it("registers every scheduled task", () => {
    const items = parseCrontab(workerCrontab);
    expect(items).toHaveLength(1);
    expect(items[0]?.task).toBe("portable_worker_heartbeat");
    expect(taskList[items[0]?.task ?? ""]).toBeTypeOf("function");
  });
});

import type { TaskList } from "graphile-worker";

export const taskList: TaskList = {
  portable_worker_heartbeat: async (_payload, helpers) => {
    await helpers.query(
      `INSERT INTO worker_heartbeats (worker_name, last_seen_at, metadata)
       VALUES ('default', now(), jsonb_build_object('workerId', $1::text))
       ON CONFLICT (worker_name) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         metadata = excluded.metadata`,
      [helpers.job.locked_by ?? "unknown"],
    );
  },
};

export const workerCrontab =
  "* * * * * portable_worker_heartbeat ?max=3&jobKey=portable-worker-heartbeat";

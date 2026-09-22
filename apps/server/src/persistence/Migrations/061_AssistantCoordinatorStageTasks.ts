import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Issues the retired coordinator worked still carry `stage: "coordinator"`,
 * which left the task schema with it (057). One such row fails the board's
 * decode and the whole page reports that the assistant cannot be reached, so
 * the finished issues drop the stage the way the oldest tasks already have it:
 * absent. Only settled rows can hold it — the coordinator ran no live issue
 * past 057 — so nothing active loses its place in a team.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE assistant_tasks SET data = json_remove(data, '$.stage')
    WHERE json_extract(data, '$.stage') = 'coordinator'`;
});

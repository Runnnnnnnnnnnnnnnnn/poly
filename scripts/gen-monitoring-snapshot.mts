import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { getMonitoringSnapshot } from "../src/lib/monitoring/service";

const output = resolve("public/monitoring-snapshot.json");

try {
  const snapshot = await getMonitoringSnapshot();
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`monitoring snapshot: ${snapshot.collection.totalRecords} records -> ${output}`);
} catch (error) {
  console.error(`monitoring snapshot generation failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

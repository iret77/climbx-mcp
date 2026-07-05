/**
 * Live smoke test against the real ClimbX API.
 *
 * Usage:
 *   CLIMBX_API_KEY=climbx_sk_... npm run smoke            # read-only endpoints
 *   CLIMBX_API_KEY=climbx_sk_... npm run smoke -- --write # + schedule/cancel roundtrip
 *
 * WARNING: --write consumes one slot of the 5/day post cap permanently;
 * cancelling a scheduled post does not refund the slot.
 */
import { ClimbxClient } from "../src/client.js";

const apiKey = process.env.CLIMBX_API_KEY;
if (!apiKey) {
  console.error("CLIMBX_API_KEY is not set. Aborting.");
  process.exit(1);
}

const writeMode = process.argv.includes("--write");
const client = new ClimbxClient({
  apiKey,
  baseUrl: process.env.CLIMBX_BASE_URL,
  allowCustomHost: process.env.CLIMBX_ALLOW_CUSTOM_BASE_URL === "1",
});

function preview(data: unknown): string {
  const json = JSON.stringify(data);
  return json.length > 200 ? json.slice(0, 200) + "..." : json;
}

async function step(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    const data = await fn();
    console.log(`✔ ${name}: ${preview(data)}`);
    return true;
  } catch (err) {
    console.error(`✘ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

let failures = 0;
const check = async (name: string, fn: () => Promise<unknown>) => {
  if (!(await step(name, fn))) failures++;
};

await check("GET /posts", () => client.get("/posts", { limit: 3 }));
await check("GET /schedule", () => client.get("/schedule"));
await check("GET /analytics", () => client.get("/analytics", { days: 30 }));
await check("GET /analytics/formats", () => client.get("/analytics/formats"));
await check("GET /analytics/niches", () => client.get("/analytics/niches"));
await check("GET /voice", () => client.get("/voice"));
await check("GET /learnings", () => client.get("/learnings"));
await check("GET /learnings/history", () => client.get("/learnings/history"));
await check("GET /inspiration/options", () => client.get("/inspiration/options"));
await check("GET /inspiration/following", () => client.get("/inspiration/following", { limit: 5 }));
await check("GET /inspiration/surprise", () => client.get("/inspiration/surprise", { min_multiplier: 3, limit: 5 }));

if (writeMode) {
  console.log("\n--write: schedule/cancel roundtrip (consumes one daily-cap slot!)");
  const inOneYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  let scheduledId: string | undefined;
  await check("POST /schedule", async () => {
    const res = (await client.post("/schedule", {
      text: "climbx-mcp smoke test, will be cancelled immediately.",
      scheduled_for: inOneYear,
    })) as { scheduled?: { id?: string } };
    scheduledId = res.scheduled?.id;
    return res;
  });
  if (scheduledId) {
    await check("DELETE /schedule/{id}", () => client.delete(`/schedule/${scheduledId}`));
  }
} else {
  console.log("\n(write endpoints skipped; pass --write to include them, costs a daily-cap slot)");
}

console.log(failures === 0 ? "\nSmoke test passed." : `\nSmoke test finished with ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);

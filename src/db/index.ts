import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { config } from "../config";

const client = postgres(config.databaseUrl, {
  connection: { timezone: "UTC" },
});
export const db = drizzle(client, { schema });
export { client };
export type DB = typeof db;

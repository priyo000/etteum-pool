import { runMigrations } from "../src/db/migrate";
import { client } from "../src/db/index";

await runMigrations();
const rows = client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
console.log(JSON.stringify(rows));

#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { Client } = require("@notionhq/client");

const repoRoot = path.resolve(__dirname, "..");
const localEnvPath = path.join(repoRoot, ".env.local");

const loadLocalEnv = () => {
  if (!fs.existsSync(localEnvPath)) {
    return;
  }

  const lines = fs.readFileSync(localEnvPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) {
      continue;
    }
    const [rawKey, ...rawValue] = line.split("=");
    const key = rawKey.trim();
    const value = rawValue.join("=").trim();
    if (key && value && !process.env[key]) {
      process.env[key] = value;
    }
  }
};

loadLocalEnv();

const { NOTION_API_KEY, NOTION_DATABASE_ID, NOTION_STATUS_PROPERTY_ID } =
  process.env;

if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.error(
    "Missing NOTION_API_KEY or NOTION_DATABASE_ID. Populate `.env.local` or export them in your shell."
  );
  process.exit(1);
}

const notion = new Client({ auth: NOTION_API_KEY });

const main = async () => {
  const database = await notion.databases.retrieve({
    database_id: NOTION_DATABASE_ID,
  });

  const entries = Object.entries(database.properties ?? {});
  console.log("Notion database properties:");
  for (const [key, value] of entries) {
    console.log(` • ${key} (type: ${value.type}, id: ${value.id})`);
  }

  const statusByName = database.properties?.Status;
  console.log("Status by name:", {
    present: Boolean(statusByName),
    id: statusByName?.id ?? null,
    type: statusByName?.type ?? null,
  });

  if (NOTION_STATUS_PROPERTY_ID) {
    const match = entries.find(([, value]) => value.id === NOTION_STATUS_PROPERTY_ID);
    console.log("Status by configured ID:", {
      present: Boolean(match),
      key: match?.[0] ?? null,
      type: match?.[1]?.type ?? null,
    });
  }
};

main().catch((error) => {
  console.error("Notion check failed:", error);
  process.exit(1);
});

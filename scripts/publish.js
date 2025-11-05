import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import { Octokit } from "@octokit/rest";

const REQUIRED_ENV_VARS = [
  "NOTION_API_KEY",
  "NOTION_DATABASE_ID",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
];

const missingEnv = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnv.join(", ")}`
  );
  process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

console.log("Notion publish script v20250223-1");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const targetBranch = process.env.PUBLISH_BRANCH || "main";
const blogRoot = "src/content/blog";

const STATUS_READY = "Ready to Publish";
const STATUS_PUBLISHED = "Published";
const STATUS_PROPERTY_NAME =
  process.env.NOTION_STATUS_PROPERTY_NAME || "Status";
const STATUS_PROPERTY_ID = process.env.NOTION_STATUS_PROPERTY_ID;

let resolvedStatusProperty;
let supportsDatabasesQuery;

const queryDatabase = async ({ database_id, filter, sorts, start_cursor, page_size }) => {
  if (supportsDatabasesQuery === undefined) {
    supportsDatabasesQuery = typeof notion.databases.query === "function";
    if (!supportsDatabasesQuery) {
      console.log("Falling back to notion.request for database queries (databases.query not available).");
    }
  }

  if (supportsDatabasesQuery) {
    return notion.databases.query({
      database_id,
      filter,
      sorts,
      start_cursor,
      page_size,
    });
  }

  return notion.request({
    path: `databases/${database_id}/query`,
    method: "POST",
    body: {
      filter,
      sorts,
      start_cursor,
      page_size,
    },
  });
};

const slugify = (value) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

const extractText = (richText = []) =>
  richText.map((fragment) => fragment.plain_text).join("").trim();

const formatTags = (tags = []) => tags.map((tag) => tag.name);

const getFrontmatter = ({ title, date, tags }) => {
  const lines = ["---", `title: ${JSON.stringify(title)}`];

  if (date) {
    lines.push(`date: ${date}`);
  }

  if (tags?.length) {
    lines.push("tags:");
    for (const tag of tags) {
      lines.push(`  - ${JSON.stringify(tag)}`);
    }
  }

  lines.push("---", "");
  return lines.join("\n");
};

const getExistingFileSha = async (path) => {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: targetBranch,
    });

    if (!("sha" in data)) {
      return null;
    }

    return data.sha;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
};

const normalizeKey = (key = "") => key.trim().toLowerCase();

const resolveStatusProperty = async () => {
  if (resolvedStatusProperty) {
    return resolvedStatusProperty;
  }

  const database = await notion.databases.retrieve({
    database_id: process.env.NOTION_DATABASE_ID,
  });

  const propertyEntries = Object.entries(database.properties ?? {});
  const propertySummary = propertyEntries
    .map(([key, value]) => `${key} (${value.type}, id: ${value.id})`)
    .join(", ");
  console.log("Notion database properties:", propertySummary);

  let matchedEntry = null;

  if (STATUS_PROPERTY_ID) {
    matchedEntry = propertyEntries.find(([, value]) => value.id === STATUS_PROPERTY_ID);
    if (!matchedEntry) {
      console.warn(
        `Configured property id "${STATUS_PROPERTY_ID}" not found in Notion database ${process.env.NOTION_DATABASE_ID}`
      );
    }
  }

  if (!matchedEntry) {
    matchedEntry = propertyEntries.find(
      ([key]) => normalizeKey(key) === normalizeKey(STATUS_PROPERTY_NAME)
    );
  }

  if (!matchedEntry) {
    throw new Error(
      `Property "${STATUS_PROPERTY_NAME}" not found in Notion database ${process.env.NOTION_DATABASE_ID}. Available keys: ${propertyEntries
        .map(([key]) => key)
        .join(", ")}`
    );
  }

  const [propertyKey, propertyValue] = matchedEntry;
  resolvedStatusProperty = {
    key: propertyKey,
    id: propertyValue.id,
    type: propertyValue.type,
  };
  console.log(
    `Resolved status property "${propertyKey}" (id: ${propertyValue.id}) of type "${propertyValue.type}"`
  );

  return resolvedStatusProperty;
};

const buildStatusFilter = async () => {
  const { type } = await resolveStatusProperty();

  if (type === "select") {
    return {
      select: {
        equals: STATUS_READY,
      },
    };
  }

  return {
    status: {
      equals: STATUS_READY,
    },
  };
};

const queryReadyPages = async () => {
  const statusFilter = await buildStatusFilter();
  const { key } = await resolveStatusProperty();
  const response = await queryDatabase({
    database_id: process.env.NOTION_DATABASE_ID,
    filter: {
      property: key,
      ...statusFilter,
    },
  });

  return response.results;
};

const convertPageToMarkdown = async (pageId) => {
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  const mdString = await n2m.toMarkdownString(mdBlocks);
  if (typeof mdString === "string") {
    return mdString;
  }
  return mdString.parent;
};

const getStatusUpdatePayload = (statusType) => {
  if (statusType === "select") {
    return {
      select: {
        name: STATUS_PUBLISHED,
      },
    };
  }

  return {
    status: {
      name: STATUS_PUBLISHED,
    },
  };
};

const updatePageStatus = async (pageId, statusType) => {
  const { key } = await resolveStatusProperty();
  return notion.pages.update({
    page_id: pageId,
    properties: {
      [key]: getStatusUpdatePayload(statusType),
    },
  });
};

const publishPost = async (page) => {
  const statusMeta = await resolveStatusProperty();
  const pageId = page.id;
  const titleProperty = page.properties?.Name;
  const title = extractText(titleProperty?.title) || "untitled";
  const slug = slugify(title);

  const dateProperty = page.properties?.Date;
  const dateValue = dateProperty?.date?.start;

  const tagsProperty = page.properties?.Tags;
  let tags = [];
  if (tagsProperty?.type === "multi_select") {
    tags = formatTags(tagsProperty.multi_select);
  } else if (tagsProperty?.type === "select" && tagsProperty.select) {
    tags = [tagsProperty.select.name];
  } else if (Array.isArray(tagsProperty?.multi_select)) {
    tags = formatTags(tagsProperty.multi_select);
  }

  const statusProperty = page.properties?.[statusMeta.key];
  const markdownBody = await convertPageToMarkdown(pageId);
  const frontmatter = getFrontmatter({ title, date: dateValue, tags });
  const postContent = `${frontmatter}${markdownBody}\n`;
  const filePath = `${blogRoot}/${slug}.md`;
  const sha = await getExistingFileSha(filePath);

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: `Add blog post for ${title}`,
    content: Buffer.from(postContent).toString("base64"),
    branch: targetBranch,
    sha: sha ?? undefined,
  });

  await updatePageStatus(pageId, statusProperty?.type ?? statusMeta.type);
  console.log(`Published "${title}" to ${filePath}`);
};

const main = async () => {
  const pages = await queryReadyPages();
  if (pages.length === 0) {
    console.log("No pages ready for publishing.");
    return;
  }

  for (const page of pages) {
    try {
      await publishPost(page);
    } catch (error) {
      console.error(`Failed to publish page ${page.id}:`, error);
    }
  }
};

main().catch((error) => {
  console.error("Publish script failed:", error);
  process.exit(1);
});

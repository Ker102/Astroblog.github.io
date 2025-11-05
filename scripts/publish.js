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

const notion = new Client({
  auth: process.env.NOTION_API_KEY,
  notionVersion: "2022-06-28",
});
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

const TITLE_PROPERTY_NAME =
  process.env.NOTION_TITLE_PROPERTY_NAME || "Title";
const DESCRIPTION_PROPERTY_NAME =
  process.env.NOTION_DESCRIPTION_PROPERTY_NAME || "Preview Text";
const DATE_PROPERTY_NAME =
  process.env.NOTION_DATE_PROPERTY_NAME || "Publish Date";
const TAGS_PROPERTY_NAME =
  process.env.NOTION_TAGS_PROPERTY_NAME || "Tags";

let resolvedStatusProperty;
let supportsDatabasesQuery;

if (STATUS_PROPERTY_ID) {
  console.log(`NOTION_STATUS_PROPERTY_ID provided: ${STATUS_PROPERTY_ID}`);
}
if (process.env.NOTION_STATUS_PROPERTY_NAME) {
  console.log(
    `NOTION_STATUS_PROPERTY_NAME override: ${process.env.NOTION_STATUS_PROPERTY_NAME}`
  );
}

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

const getFrontmatter = ({ title, description, pubDate, updatedDate, tags }) => {
  const lines = ["---", `title: ${JSON.stringify(title)}`];

  if (description) {
    lines.push(`description: ${JSON.stringify(description)}`);
  }

  if (pubDate) {
    lines.push(`pubDate: ${pubDate}`);
  }

  if (updatedDate) {
    lines.push(`updatedDate: ${updatedDate}`);
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
  const propertySummaryLines = propertyEntries.map(([key, value]) => {
    return ` • ${key} (type: ${value.type}, id: ${value.id})`;
  });
  console.log("Notion database properties:\n" + propertySummaryLines.join("\n"));

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
  const titleProperty = page.properties?.[TITLE_PROPERTY_NAME];
  const title = extractText(titleProperty?.title) || "";
  if (!title) {
    console.warn(`Skipping page ${pageId} - missing title in property "${TITLE_PROPERTY_NAME}"`);
    return;
  }
  const slug = slugify(title) || slugify(page.id);

  const descriptionProperty = page.properties?.[DESCRIPTION_PROPERTY_NAME];
  const description = extractText(descriptionProperty?.rich_text) || "";
  if (!description) {
    console.warn(
      `Skipping page ${pageId} - missing description in property "${DESCRIPTION_PROPERTY_NAME}"`
    );
    return;
  }

  const dateProperty = page.properties?.[DATE_PROPERTY_NAME];
  const dateValue = dateProperty?.date?.start || page.created_time;
  if (!dateValue) {
    console.warn(`Skipping page ${pageId} - missing publish date in property "${DATE_PROPERTY_NAME}"`);
    return;
  }
  const pubDateIso = new Date(dateValue).toISOString();
  const updatedIso = page.last_edited_time
    ? new Date(page.last_edited_time).toISOString()
    : undefined;

  const tagsProperty = page.properties?.[TAGS_PROPERTY_NAME];
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
  const frontmatter = getFrontmatter({
    title,
    description,
    pubDate: pubDateIso,
    updatedDate: updatedIso,
    tags,
  });
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

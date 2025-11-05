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

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const targetBranch = process.env.PUBLISH_BRANCH || "main";
const blogRoot = "src/content/blog";

const STATUS_READY = "Ready to Publish";
const STATUS_PUBLISHED = "Published";

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

const queryReadyPages = async () => {
  const pages = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID,
    filter: {
      property: "Status",
      status: {
        equals: STATUS_READY,
      },
    },
  });

  return pages.results;
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

const updatePageStatus = (pageId, statusType) =>
  notion.pages.update({
    page_id: pageId,
    properties: {
      Status: getStatusUpdatePayload(statusType),
    },
  });

const publishPost = async (page) => {
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

  const statusProperty = page.properties?.Status;
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

  await updatePageStatus(pageId, statusProperty?.type);
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

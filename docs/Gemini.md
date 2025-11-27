# Gemini Context & Guide

This file serves as a reference for AI agents (and humans) to understand the structure, purpose, and workflows of this repository.

## Project Overview
**Name**: `popular-photon` (Astro Blog Starter)
**Type**: Static Site Generator (Astro)
**Purpose**: A personal blog integrated with Notion for content management.
**Deployed URL**: `https://ker102.github.io/Astroblogauto/`

## Tech Stack
- **Framework**: [Astro](https://astro.build/) (v5.x)
- **UI Library**: React (v19.x)
- **Content**: MDX, Notion (via `notion-to-md`)
- **Styling**: Minimal CSS (Bear Blog theme basis)
- **Package Manager**: npm

## Directory Structure
- **`src/`**: Source code
  - **`pages/`**: File-based routing. `.astro` and `.md` files here become pages.
  - **`content/`**: Content collections (e.g., blog posts).
  - **`components/`**: Reusable UI components (Astro, React).
  - **`layouts/`**: Page layouts.
  - **`styles/`**: Global styles.
- **`scripts/`**: Automation scripts
  - **`check-notion.cjs`**: Checks Notion for new content/updates.
  - **`publish.js`**: Handles the publishing workflow.
- **`public/`**: Static assets (images, fonts, etc.).
- **`docs/`**: Documentation (including this file).

## Key Workflows

### 1. Development
- **Start Server**: `npm run dev` (Runs on `localhost:4321`)
- **Build**: `npm run build` (Outputs to `dist/`)
- **Preview**: `npm run preview`

### 2. Content Management (Notion)
This project appears to fetch or sync content from Notion.
- **Script**: `npm run check:notion` (runs `scripts/check-notion.cjs`)
- **Dependencies**: `@notionhq/client`, `notion-to-md`

### 3. Configuration
- **`astro.config.mjs`**: Main configuration.
  - **Base Path**: `/Astroblogauto` (Important for asset links)
  - **Integrations**: MDX, React, Sitemap.

## Guidelines for AI Agents
- **Path Awareness**: Always respect the `base` path (`/Astroblogauto`) when generating links or referencing assets in the built site.
- **Component Usage**: Prefer using existing components in `src/components` before creating new ones.
- **Styling**: Maintain the minimal aesthetic. Check `src/styles` for global variables.
- **Scripts**: Be aware of the `scripts/` directory for automation tasks. Do not modify these unless explicitly requested or fixing a bug in the workflow.

## Recent Updates
- **[Date]**: Initial creation of `Gemini.md` context file.

# DocsMint Claude directory submission

This is the release worksheet for the remote connector and the Claude plugin bundle. Submit both from the same Claude organization if they should be paired. The paid Claude account that owns the listing needs GitHub push access for the bundle.

## MCP connector application

| Portal field | Proposed value |
| --- | --- |
| Server name | DocsMint |
| One-liner | Search, read, and manage your team’s DocsMint knowledge from Claude. |
| Category | Productivity, if offered |
| Slug | docsmint, subject to availability |
| Connection | Single remote HTTPS endpoint at https://docsmint.com/mcp |
| Documentation | https://docsmint.com/mcp/connect |
| Privacy | https://docsmint.com/privacy |
| Support | https://docsmint.com/contact |
| Icon | https://raw.githubusercontent.com/HiAi-gg/docsmint/main/frontend/static/logo.png |
| Product website | https://docsmint.com/ |
| Authentication | Required, user-authorized OAuth. Verify Claude's registration method against the live endpoint. |
| Data access | Reads and writes DocsMint workspace content within user-authorized grants. |
| API ownership | DocsMint Cloud tools operate on the DocsMint service. |

**Listing description**

DocsMint brings your team’s knowledge into Claude. Search project notes and decisions, read the original Markdown, and create or update documents in authorized folders. Browse workspace structure and tags, inspect document versions, and work with image attachments where those tools are available. Connect your DocsMint Cloud account and choose which workspace or categories Claude can access. Availability depends on your DocsMint plan, role, and granted permissions.

**Primary use cases**

- Find a project brief and summarize it with source references.
- Save approved meeting notes in the project folder.
- Review an existing document, take a snapshot, and apply a requested edit.
- Inspect attachments or recover a previous revision when authorized.

**Publisher and claims to review**

Confirm the publisher name and review contact with the person submitting. Use the data handling questions to describe workspace content, including the possibility of user-provided personal data. The bundle stores no account data itself. DocsMint retains workspace content according to its service policies, and Claude handles conversation content under its own policies. Confirm retention wording with the service owner and complete the portal's policy acknowledgements at submission time.

## Plugin bundle application

- Repository: https://github.com/HiAi-gg/docsmint
- Plugin folder: `plugins/claude/docsmint`
- Tracked ref: use the reviewed release branch or main once the package is merged.
- Listing description: the plugin README. Short description and version come from the manifest.
- Components: one workspace skill and the same remote HTTPS MCP endpoint as the separate connector listing.
- No bundled binaries, scripts, dependency installers, static credentials, or local execution.
- Validate the intended commit in the portal. Review the listing preview, data handling declarations and update settings before sending. Pair the two listings in the same Claude organization.

## Test before submission

Use a seeded test workspace with sample documents, a separate denied category, sample image files, and disposable documents for destructive checks. Record the enabled tool list and results for each test identity. Keep test credentials out of GitHub and supply access only through Anthropic's requested review channel.

| Check | Expected evidence |
| --- | --- |
| OAuth through Claude custom connector and Claude Code | Consent identifies Claude, selected workspace/category and permissions are applied, and tokens can refresh and be revoked. |
| Tool metadata | Capture live tools/list. Each tool has a title and the applicable hint. Check mutation annotations against Claude's rules, especially mixed create/update and batch tools. |
| Search, reads, structure, graph | Query known sample data, read source Markdown, browse entities and scope, and verify denied-category access is refused. |
| Write workflows | Create and update a fixture, inspect index health, organize with folders/categories/tags, verify snapshots and version restore, and check actual write permissions. |
| Attachments | Upload one and several sample images using available tools, then verify returned references and attachment access. |
| Trash, batches and other exposed tools | Exercise every discovered tool in MCP Inspector and Claude, including destructive actions on disposable fixtures only. Check whether template tools are exposed to the submission account and exercise them if present. |
| Bundle | Load the package in Claude Code, validate in the directory portal, and compare a representative workflow with and without the workspace skill. Check supported surfaces before claiming compatibility. |

Local package validation does not establish hosted OAuth compatibility, live tool behavior, portal validation, or Anthropic approval. If the live server exposes interactive MCP App resources, confirm eligibility and capture the required screenshots with paired prompts. Add only actual link destinations if the app uses the open-link capability.

## Anthropic references

- [Publish to the directory](https://claude.com/docs/directory/publish)
- [Submit a connector](https://claude.com/docs/connectors/building/submission)
- [Connector review criteria](https://claude.com/docs/connectors/building/review-criteria)
- [Plugin validation checklist](https://claude.com/docs/plugins/pre-submission-checklist)
- [Submit a plugin](https://claude.com/docs/plugins/submit)

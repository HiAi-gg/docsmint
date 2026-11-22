# DocsMint

Bring your DocsMint Cloud workspace into Claude. Find project briefs and decisions, read the original Markdown, and turn a conversation into a follow-up document in a folder you authorize. Use the bundled workspace skill for search, document edits, attachments, and version history.

## Connect

Use your DocsMint Cloud account and authorize Claude through DocsMint. Choose the workspace or categories you want to share. Start with read access for search and summarization, then grant edit or write access for workflows that need it. Tool availability follows your role, grant, and plan. The same hosted server can also be added in Claude as a custom connector at `https://docsmint.com/mcp`.

## Try it

| Task | Example |
| --- | --- |
| Search and read | “Find our onboarding guide in DocsMint and summarize it with source links.” |
| Organize | “Show the DocsMint folders and tags for the launch project.” |
| Create | “Save these meeting notes as a new document in the authorized Project Orion folder.” |
| Edit and verify | “Read the release checklist, take a snapshot, add the two approved tasks, and verify the saved Markdown.” |
| Attachments | “Check whether the project brief's attached diagram is accessible.” |
| Versions and trash | “Show available versions of the project brief so I can choose a revision to restore.” |

## Data and permissions

The bundle contains an instruction skill and a remote HTTPS MCP configuration. It runs no local executable or install script and contains no credentials. Connector calls send the arguments needed for your request to DocsMint Cloud. Results, including source text you request, are returned to Claude. Writes are stored in DocsMint only when an authorized write tool is called. You can revoke the OAuth grant from DocsMint MCP settings.

- [Connection help](https://docsmint.com/mcp/connect)
- [Privacy policy](https://docsmint.com/privacy)
- [Terms](https://docsmint.com/terms)
- [Support](https://docsmint.com/contact)

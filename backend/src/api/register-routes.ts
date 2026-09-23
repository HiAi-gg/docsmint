import { Elysia } from "elysia";
import { adminRoutes } from "./routes/admin";
import { attachmentRoutes } from "./routes/attachments";
import { authRoutes } from "./routes/auth";
import { categoryRoutes } from "./routes/categories";
import { collaborationRoutes } from "./routes/collaboration";
import { documentRoutes } from "./routes/documents";
import { folderRoutes } from "./routes/folders";
import { graphRoutes } from "./routes/graph";
import { keysRoutes } from "./routes/keys";
import { metricsRoutes } from "./routes/metrics";
import { pluginsRoutes } from "./routes/plugins";
import { searchRoutes } from "./routes/search";
import { shareRoutes } from "./routes/share";
import { tagRoutes } from "./routes/tags";
import { versionRoutes } from "./routes/versions";
import { visibilityRoutes } from "./routes/visibility";
import { webhookRoutes } from "./routes/webhooks";

export const selfHostedApiRoutes = new Elysia()
	.use(authRoutes)
	.use(tagRoutes)
	.use(categoryRoutes)
	.use(attachmentRoutes)
	.use(shareRoutes)
	.use(searchRoutes)
	.use(documentRoutes)
	.use(folderRoutes)
	.use(versionRoutes)
	.use(webhookRoutes)
	.use(collaborationRoutes)
	.use(graphRoutes)
	.use(keysRoutes)
	.use(pluginsRoutes)
	.use(visibilityRoutes)
	.use(adminRoutes)
	.use(metricsRoutes);

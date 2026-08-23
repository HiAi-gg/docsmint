import { describe, expect, test } from "bun:test";
import {
	createPrintableDocumentHtml,
	renderPrintableDocumentContent,
} from "./printable-document";

describe("printable document HTML", () => {
	test("escapes hostile titles and renders only sanitized canonical editor JSON", () => {
		const input = {
			contentJson: {
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [
							{
								type: "text",
								text: "<script>alert(1)</script>",
								marks: [
									{
										type: "link",
										attrs: { href: "javascript:alert(1)" },
									},
								],
							},
						],
					},
					{
						type: "image",
						attrs: { src: "javascript:alert(1)", alt: "x" },
					},
				],
			},
		};
		const content = renderPrintableDocumentContent(input);
		expect(content).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		const html = createPrintableDocumentHtml({
			title: 'Report </title><img src=x onerror="alert(1)">',
			...input,
		});

		expect(html).toContain(
			"Report &lt;/title&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
		);
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("javascript:alert(1)");
		expect(html).not.toContain(' onerror="');
	});
});
